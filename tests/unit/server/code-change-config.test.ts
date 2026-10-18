import { afterEach, expect, it, vi } from 'vitest';
import { redactAuditEvent } from '../../../src/server/audit.js';
import { createCodeChangeSink } from '../../../src/server/code-change-sink.js';
import { resolveConfig } from '../../../src/server/config.js';
import { DEFAULT_CONFIG } from '../../../src/server/types.js';

afterEach(() => vi.unstubAllEnvs());
it('defaults off and resolves explicit CLI over environment', () => {
  vi.stubEnv('ARC1_CODE_CHANGE_EVENTS', 'true');
  vi.stubEnv('ARC1_CODE_CHANGE_WEBHOOK_URL', 'https://events.test/hook');
  vi.stubEnv('ARC1_CODE_CHANGE_WEBHOOK_TOKEN', 'PRIVATE_TOKEN');
  const result = resolveConfig([]);
  expect(result.config).toMatchObject({
    codeChangeEvents: true,
    codeChangeWebhookUrl: 'https://events.test/hook',
    codeChangeWebhookToken: 'PRIVATE_TOKEN',
  });
  expect(result.sources.codeChangeEvents).toEqual({ env: 'ARC1_CODE_CHANGE_EVENTS' });
  vi.stubEnv('ARC1_CODE_CHANGE_WEBHOOK_URL', '');
  vi.stubEnv('ARC1_CODE_CHANGE_WEBHOOK_TOKEN', '');
  expect(resolveConfig(['--code-change-events', 'false']).config.codeChangeEvents).toBe(false);
  expect(createCodeChangeSink(DEFAULT_CONFIG)).toBeUndefined();
});
it('redacts the webhook token in ordinary argument audit logging', () => {
  const safe = redactAuditEvent({
    event: 'tool_call_start',
    tool: 'test',
    timestamp: '',
    level: 'info',
    args: { codeChangeWebhookToken: 'PRIVATE_TOKEN' },
  });
  expect(JSON.stringify(safe)).not.toContain('PRIVATE_TOKEN');
});
