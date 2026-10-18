import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ServerConfig } from './types.js';

export function codeChangeLogPath(config: ServerConfig): string {
  return (
    config.codeChangeLog ??
    join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'arc-1', 'events', 'code-changes.jsonl')
  );
}

export function validateCodeChangeConfig(config: ServerConfig): void {
  if (config.codeChangeLog && !isAbsolute(config.codeChangeLog))
    throw new Error('Code-change log path must be absolute.');
  if (config.codeChangeWebhookToken && (!config.codeChangeWebhookUrl || /[\r\n]/.test(config.codeChangeWebhookToken)))
    throw new Error('A webhook token requires a webhook URL and must not contain newlines.');
  if (!config.codeChangeWebhookUrl) return;
  let url: URL;
  try {
    url = new URL(config.codeChangeWebhookUrl);
  } catch {
    throw new Error('Invalid code-change webhook URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error(
      'Code-change webhook requires HTTPS with no credentials, query string or fragment. Use the separate token setting.',
    );
  if (!config.codeChangeEvents) throw new Error('Enable code-change events before configuring a webhook.');
}
