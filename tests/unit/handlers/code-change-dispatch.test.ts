import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../../src/server/audit.js';
import { logger } from '../../../src/server/logger.js';
import { DEFAULT_CONFIG } from '../../../src/server/types.js';
import { mockResponse } from '../../helpers/mock-fetch.js';
import { createClient, mockFetch } from './setup-undici-mock.js';

const { handleToolCall, getToolRegistry } = await import('../../../src/handlers/dispatch.js');
const config = { ...DEFAULT_CONFIG, url: 'https://sap.test', allowWrites: true, codeChangeEvents: true };
const args = { action: 'update', type: 'PROG', name: 'ZTEST', source: 'PRIVATE_SOURCE' };
beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(mockResponse(200, '', { 'x-csrf-token': 'test-token' }));
});
afterEach(() => vi.restoreAllMocks());
function events(spy: { mock: { calls: [AuditEvent][] } }) {
  return spy.mock.calls.map((c) => c[0]).filter((e) => e.event === 'code_change');
}
it('emits exactly one event per direct or hyperfocused write with separate HTTP evidence', async () => {
  const client = createClient();
  const audit = vi.spyOn(logger, 'emitAudit');
  vi.spyOn(getToolRegistry().get('SAPWrite')!, 'invoke').mockImplementation(async () => {
    await client.http.put(
      '/sap/bc/adt/programs/programs/ztest/source/main?lockHandle=PRIVATE_HANDLE',
      'PRIVATE_SOURCE',
    );
    return { content: [{ type: 'text', text: 'done' }] };
  });
  for (const [tool, input] of [
    ['SAPWrite', args],
    ['SAP', { action: 'write', params: args }],
  ] as const) {
    audit.mockClear();
    const result = await handleToolCall(client, config, tool, input);
    expect(result.isError).not.toBe(true);
    expect(events(audit)).toHaveLength(1);
    expect(events(audit)[0]).toMatchObject({
      tool: 'SAPWrite',
      outcome: 'http_accepted',
      operationStatus: 'completed',
      evidence: { accepted: 1 },
      requestedObjects: [{ name: 'ZTEST', type: 'PROG' }],
    });
    expect(JSON.stringify(events(audit))).not.toMatch(/PRIVATE_SOURCE|PRIVATE_HANDLE|test-token/);
  }
});
it('preserves accepted save evidence if a later activation or unlock fails', async () => {
  const client = createClient();
  const audit = vi.spyOn(logger, 'emitAudit');
  vi.spyOn(getToolRegistry().get('SAPWrite')!, 'invoke').mockImplementation(async () => {
    await client.http.put('/sap/bc/adt/programs/programs/ztest/source/main', 'PRIVATE_SOURCE');
    throw new Error('activation failed');
  });
  const result = await handleToolCall(client, config, 'SAPWrite', args);
  expect(result.isError).toBe(true);
  expect(events(audit)[0]).toMatchObject({ outcome: 'partial', operationStatus: 'failed', evidence: { accepted: 1 } });
});
it('suppresses dry runs, disabled events, no-ops, reads and customising previews', async () => {
  const client = createClient();
  const audit = vi.spyOn(logger, 'emitAudit');
  vi.spyOn(getToolRegistry().get('SAPWrite')!, 'invoke').mockResolvedValue({
    content: [{ type: 'text', text: 'no changes' }],
  });
  await handleToolCall(client, config, 'SAPWrite', { ...args, dryRun: true });
  await handleToolCall(client, { ...config, codeChangeEvents: false }, 'SAPWrite', args);
  await handleToolCall(client, config, 'SAPWrite', args);
  vi.spyOn(getToolRegistry().get('SAPRead')!, 'invoke').mockResolvedValue({
    content: [{ type: 'text', text: 'source' }],
  });
  await handleToolCall(client, config, 'SAPRead', { type: 'PROG', name: 'ZTEST' });
  vi.spyOn(getToolRegistry().get('SAPCustomizing')!, 'invoke').mockResolvedValue({
    content: [{ type: 'text', text: 'prepared' }],
  });
  await handleToolCall(client, config, 'SAPCustomizing', { action: 'discover', query: 'Z*' });
  expect(events(audit)).toEqual([]);
});
it('cannot change authorization or invoke a denied write', async () => {
  const client = createClient();
  const invoke = vi.spyOn(getToolRegistry().get('SAPWrite')!, 'invoke');
  const result = await handleToolCall(client, { ...config, denyActions: ['SAPWrite.update'] }, 'SAPWrite', args);
  expect(result.isError).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});
