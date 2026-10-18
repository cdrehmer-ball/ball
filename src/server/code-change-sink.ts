import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEvent } from './audit.js';
import { codeChangeLogPath, validateCodeChangeConfig } from './code-change-config.js';
import type { LogSink } from './sinks/types.js';
import type { ServerConfig } from './types.js';

interface Options {
  file: string;
  url?: string;
  token?: string;
}
const MAX_PENDING = 256;
const ATTEMPTS = 3;

/** Local record first; optional best-effort webhook. Delivery never repeats or rolls back a SAP write. */
export class CodeChangeSink implements LogSink {
  private localTail: Promise<void> = Promise.resolve();
  private pendingLocal = 0;
  private ready?: Promise<void>;
  private queue: Array<{ id: string; body: string }> = [];
  private delivery?: Promise<void>;
  private controller = new AbortController();
  private closing = false;
  private lastWarning = 0;
  constructor(private options: Options) {}

  write(event: AuditEvent): void {
    if (event.event !== 'code_change' || this.closing) return;
    if (this.pendingLocal >= MAX_PENDING) {
      this.warn('local_queue_full');
      return;
    }
    // Event is already redacted by Logger; it contains metadata only.
    const body = JSON.stringify(event);
    this.pendingLocal++;
    this.localTail = this.localTail
      .then(async () => {
        this.ready ??= mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 })
          .then(() => appendFile(this.options.file, '', { mode: 0o600 }))
          .then(() => chmod(this.options.file, 0o600));
        await this.ready;
        await appendFile(this.options.file, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
        if (this.options.url) {
          if (this.queue.length >= MAX_PENDING) this.warn('webhook_queue_full');
          else {
            this.queue.push({ id: event.eventId, body });
            this.startDelivery();
          }
        }
      })
      .catch(() => {
        this.ready = undefined;
        this.warn('local_write_failed');
      })
      .finally(() => {
        this.pendingLocal--;
      });
  }

  private startDelivery() {
    if (this.delivery || this.controller.signal.aborted) return;
    this.delivery = this.deliver().finally(() => {
      this.delivery = undefined;
      if (this.queue.length && !this.controller.signal.aborted) this.startDelivery();
    });
  }
  private async deliver() {
    while (this.queue.length && !this.controller.signal.aborted) {
      const item = this.queue.shift()!;
      let sent = false;
      for (let attempt = 0; attempt < ATTEMPTS && !this.controller.signal.aborted; attempt++) {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': item.id };
          if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
          const response = await fetch(this.options.url!, {
            method: 'POST',
            headers,
            body: item.body,
            redirect: 'error',
            signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(3000)]),
          });
          await response.body?.cancel(); // Never read or log an untrusted response body.
          if (response.ok) {
            sent = true;
            break;
          }
          if (response.status < 500 && ![408, 429].includes(response.status)) break;
        } catch {
          /* No URL/token/response/error text in delivery diagnostics. */
        }
        if (attempt < ATTEMPTS - 1 && !this.controller.signal.aborted)
          await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
      if (!sent) this.warn('webhook_delivery_failed');
    }
  }
  private warn(code: string) {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    process.stderr.write(`[CodeChangeEvents] ${code}; inspect the local event log.\n`);
  }
  async flush(): Promise<void> {
    this.closing = true;
    await this.localTail;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.delivery,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.controller.abort();
      if (this.queue.length) this.warn('webhook_shutdown_pending');
      this.queue = [];
    }
  }
}

export function createCodeChangeSink(config: ServerConfig): CodeChangeSink | undefined {
  validateCodeChangeConfig(config);
  return config.codeChangeEvents
    ? new CodeChangeSink({
        file: codeChangeLogPath(config),
        url: config.codeChangeWebhookUrl,
        token: config.codeChangeWebhookToken,
      })
    : undefined;
}
