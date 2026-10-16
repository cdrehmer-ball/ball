import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '../../../src/server/logger.js';
import { DEFAULT_CONFIG } from '../../../src/server/types.js';
import { createClient } from './setup-undici-mock.js';

const { handleToolCall } = await import('../../../src/handlers/dispatch.js');
const { handleSAPCustomizing } = await import('../../../src/handlers/customizing.js');
const config = { ...DEFAULT_CONFIG, url: 'https://sap.test', allowDataPreview: true };
afterEach(() => vi.restoreAllMocks());
it('redacts customising values and errors in ordinary audit logs', async () => {
  const client = createClient();
  const query = vi
    .spyOn(client, 'runTableQuery')
    .mockResolvedValue({ columns: [], rows: [{ TABNAME: 'PRIVATE_CONFIG_VALUE', CONTFLAG: 'C' }] });
  const audit = vi.spyOn(logger, 'emitAudit');
  const result = await handleToolCall(client, config, 'SAPCustomizing', { action: 'discover', query: 'PRIVATE_INPUT' });
  expect(result.isError).not.toBe(true);
  expect(result.content[0].text).toContain('PRIVATE_CONFIG_VALUE');
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(/PRIVATE_CONFIG_VALUE|PRIVATE_INPUT/);
  query.mockRejectedValue(new Error('PRIVATE_ERROR_VALUE'));
  await handleToolCall(client, config, 'SAPCustomizing', { action: 'discover', query: 'PRIVATE_INPUT' });
  expect(JSON.stringify(audit.mock.calls)).not.toContain('PRIVATE_ERROR_VALUE');
});
it('enforces data opt-in and rejects non-local deployments before SAP reads', async () => {
  const client = createClient();
  client.safety.allowDataPreview = false;
  const query = vi.spyOn(client, 'runTableQuery');
  await expect(handleSAPCustomizing(client, { action: 'discover', query: 'T*' }, config)).rejects.toThrow();
  await expect(
    handleSAPCustomizing(client, { action: 'discover', query: 'T*' }, { ...config, transport: 'http-streamable' }),
  ).rejects.toThrow('local');
  expect(query).not.toHaveBeenCalled();
});
