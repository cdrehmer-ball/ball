import { randomUUID } from 'node:crypto';
import { AdtApiError } from '../adt/errors.js';
import type { AuditEventBase } from './audit.js';
import { getCurrentContext } from './context.js';

export interface CodeChangeEvent extends AuditEventBase {
  event: 'code_change';
  schemaVersion: 1;
  eventId: string;
  system: string;
  sapClient: string;
  tool: string;
  action: string;
  requestedObjects: Array<{ type?: string; name: string }>;
  objectsTruncated: boolean;
  requestedTransport?: string;
  operationStatus: 'completed' | 'failed';
  outcome: 'http_accepted' | 'rejected' | 'unknown' | 'partial' | 'not_attempted';
  evidence: { accepted: number; rejected: number; unknown: number };
  verification: 'not_performed';
}

const identifier = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z0-9_/$~.-]{1,120}$/.test(v) ? v : undefined;

/** Only repository/code-changing operations; never trace controls, reads, CTS administration or previews. */
export function isCodeChangeOperation(tool: string, action: string): boolean {
  return (
    tool === 'SAPWrite' ||
    tool === 'SAPActivate' ||
    (tool === 'SAPManage' &&
      ['create_package', 'delete_package', 'change_package', 'set_api_state'].includes(action)) ||
    (tool === 'SAPDiagnose' && action === 'apply_quickfix') ||
    (tool === 'SAPGit' && ['clone', 'pull', 'switch_branch'].includes(action))
  );
}

export class CodeChangeTracker {
  readonly evidence = { accepted: 0, rejected: 0, unknown: 0 };
  private finished = false;
  private readonly objects: CodeChangeEvent['requestedObjects'];
  private readonly objectsTruncated: boolean;
  private readonly transport?: string;
  constructor(
    private readonly meta: {
      system: string;
      sapClient: string;
      tool: string;
      action: string;
      user?: string;
      requestId: string;
    },
    args: Record<string, unknown>,
  ) {
    const candidates = Array.isArray(args.objects) ? args.objects : [args];
    this.objects = candidates.slice(0, 50).flatMap((v) => {
      if (!v || typeof v !== 'object') return [];
      const name = identifier(v.name);
      return name ? [{ name, type: identifier(v.type) }] : [];
    });
    this.objectsTruncated = candidates.length > 50;
    this.transport = identifier(args.transport);
  }
  finish(failed: boolean): CodeChangeEvent | undefined {
    if (this.finished) return;
    this.finished = true;
    const { accepted, rejected, unknown } = this.evidence;
    // A successful dry run/no-op/read-only plan is not a code-change event.
    if (!failed && accepted + rejected + unknown === 0) return;
    const outcome =
      accepted && (rejected || unknown || failed)
        ? 'partial'
        : unknown
          ? 'unknown'
          : accepted
            ? 'http_accepted'
            : rejected
              ? 'rejected'
              : 'not_attempted';
    return {
      ...this.meta,
      schemaVersion: 1,
      event: 'code_change',
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      level: failed || outcome !== 'http_accepted' ? 'warn' : 'info',
      requestedObjects: this.objects,
      objectsTruncated: this.objectsTruncated,
      requestedTransport: this.transport,
      operationStatus: failed ? 'failed' : 'completed',
      outcome,
      evidence: { ...this.evidence },
      verification: 'not_performed',
    };
  }
}

/** HTTP methods alone are insufficient: ADT also uses POST for reads, locking and checks. */
export function isChangeRequest(method: string, path: string): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  let url: URL;
  try {
    url = new URL(path, 'https://sap.invalid');
  } catch {
    return false;
  }
  if (url.searchParams.get('step')?.toLowerCase() === 'preview') return false;
  const action = url.searchParams.get('_action')?.toUpperCase();
  if (action && ['LOCK', 'UNLOCK'].includes(action)) return false;
  if (method === 'POST') {
    const readEndpoints = [
      '/sap/bc/adt/datapreview',
      '/sap/bc/adt/checkruns',
      '/sap/bc/adt/atc/runs',
      '/sap/bc/adt/abapunit',
      '/sap/bc/adt/core/discovery',
      '/sap/bc/adt/discovery',
      '/sap/bc/adt/quickfixes/evaluation',
      '/sap/bc/adt/abapsource/prettyprinter',
      '/sap/bc/adt/navigation',
      '/sap/bc/adt/abapsource/codecompletion',
      '/sap/bc/adt/repository/informationsystem/usageReferences',
    ];
    if (readEndpoints.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return false;
  }
  if (url.pathname === '/sap/bc/adt/core/http/sessions') return false;
  return true;
}

/** Observe one logical request after internal retries. Never retain request/response bodies or URLs. */
export async function observeCodeChangeRequest<T extends { statusCode: number }>(
  method: string,
  path: string,
  execute: () => Promise<T>,
): Promise<T> {
  const tracker = getCurrentContext()?.codeChange;
  if (!tracker || !isChangeRequest(method, path)) return execute();
  try {
    const response = await execute();
    if (response.statusCode >= 200 && response.statusCode < 300 && response.statusCode !== 202)
      tracker.evidence.accepted++;
    else tracker.evidence.unknown++;
    return response;
  } catch (error) {
    // Timeout/5xx/429 can arrive after a server-side write. Never call those a confirmed rejection.
    if (
      error instanceof AdtApiError &&
      error.statusCode >= 400 &&
      error.statusCode < 500 &&
      ![408, 429].includes(error.statusCode)
    )
      tracker.evidence.rejected++;
    else tracker.evidence.unknown++;
    throw error;
  }
}

/** Configuration may identify SAP through a destination rather than a direct URL. */
export function codeChangeSystem(url: string, destination?: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return identifier(destination) ?? 'unresolved';
  }
}
