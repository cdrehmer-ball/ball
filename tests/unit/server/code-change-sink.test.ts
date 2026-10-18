import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateCodeChangeConfig } from '../../../src/server/code-change-config.js';
import { CodeChangeTracker } from '../../../src/server/code-change-events.js';
import { CodeChangeSink } from '../../../src/server/code-change-sink.js';
import { DEFAULT_CONFIG } from '../../../src/server/types.js';

const event = () => {
  const t = new CodeChangeTracker(
    { system: 'https://sap.test', sapClient: '017', tool: 'SAPWrite', action: 'update', requestId: 'req' },
    { name: 'ZTEST' },
  );
  t.evidence.accepted++;
  return t.finish(false)!;
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arc-events-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
describe('code event delivery', () => {
  it('writes only events as ordered JSON lines; never contacts a webhook unless configured', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const file = join(dir, 'nested', 'events.jsonl');
    const sink = new CodeChangeSink({ file });
    const a = event(),
      b = event();
    sink.write({ event: 'tool_call_start', timestamp: '', level: 'info', tool: 'SAPRead', args: { source: 'SECRET' } });
    sink.write(a);
    sink.write(b);
    await sink.flush();
    expect(
      (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).eventId),
    ).toEqual([a.eventId, b.eventId]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('persists before delivery and retries with the same idempotency key', async () => {
    const file = join(dir, 'events.jsonl');
    const e = event();
    const fetcher = vi.fn();
    fetcher.mockImplementation(async (_url, opts) => {
      expect(await readFile(file, 'utf8')).toContain(e.eventId);
      expect(opts.redirect).toBe('error');
      expect(opts.headers.Authorization).toBe('Bearer ONLY_WEBHOOK_TOKEN');
      return new Response(null, { status: fetcher.mock.calls.length === 1 ? 503 : 204 });
    });
    vi.stubGlobal('fetch', fetcher);
    const sink = new CodeChangeSink({ file, url: 'https://events.test/hook', token: 'ONLY_WEBHOOK_TOKEN' });
    sink.write(e);
    await sink.flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(call[1].headers['Idempotency-Key']).toBe(e.eventId);
    expect(await readFile(file, 'utf8')).not.toContain('ONLY_WEBHOOK_TOKEN');
  });
  it('retains the local event on permanent webhook rejection without exposing errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('SECRET_RESPONSE', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const file = join(dir, 'events.jsonl');
    const sink = new CodeChangeSink({ file, url: 'https://events.test/private', token: 'SECRET_TOKEN' });
    sink.write(event());
    await sink.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).toContain('code_change');
    expect(JSON.stringify(stderr.mock.calls)).not.toMatch(/SECRET|events.test|private/);
  });
  it('reports local storage failures and does not deliver an unrecorded event', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sink = new CodeChangeSink({ file: dir, url: 'https://events.test/hook' });
    sink.write(event());
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'http://events.test/hook',
    'https://user:password@events.test/hook',
    'https://events.test/hook?token=secret',
    'https://events.test/hook#secret',
    'not a url',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(() =>
      validateCodeChangeConfig({ ...DEFAULT_CONFIG, codeChangeEvents: true, codeChangeWebhookUrl: url }),
    ).toThrow();
  });
  it('requires explicit opt-in, validates paths and rejects token header injection', () => {
    expect(() =>
      validateCodeChangeConfig({ ...DEFAULT_CONFIG, codeChangeWebhookUrl: 'https://events.test/hook' }),
    ).toThrow();
    expect(() => validateCodeChangeConfig({ ...DEFAULT_CONFIG, codeChangeLog: 'relative.jsonl' })).toThrow();
    expect(() =>
      validateCodeChangeConfig({
        ...DEFAULT_CONFIG,
        codeChangeEvents: true,
        codeChangeWebhookUrl: 'https://events.test/hook',
        codeChangeWebhookToken: 'bad\r\nheader',
      }),
    ).toThrow();
  });
});
