import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ChangeSet {
  version: 1;
  id: string;
  binding: string;
  system: string;
  client: string;
  object: { kind: 'table' | 'view' | 'status_profile'; name: string; textTable?: 'TJ20T' | 'TJ30T' };
  table: string;
  keys: Record<string, string>;
  before: Record<string, string>;
  changes: Record<string, string>;
  capturedAt: string;
  transport: string;
}

/** Local-only snapshots. IDs cannot select arbitrary files; caller binding prevents cross-target reuse. */
export class ChangeSetStore {
  constructor(
    private directory = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'arc-1', 'customizing'),
  ) {}
  async save(input: Omit<ChangeSet, 'id' | 'version'>): Promise<ChangeSet> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const item: ChangeSet = { ...input, id: randomUUID(), version: 1 };
    await writeFile(join(this.directory, `${item.id}.json`), JSON.stringify(item), { mode: 0o600, flag: 'wx' });
    return item;
  }
  async load(id: string, binding: string): Promise<ChangeSet> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid change-set ID.');
    const file = join(this.directory, `${id}.json`);
    if ((await stat(file)).size > 256_000) throw new Error('Change set exceeds size limit.');
    const item = JSON.parse(await readFile(file, 'utf8')) as ChangeSet;
    if (item.version !== 1 || item.id !== id || item.binding !== binding)
      throw new Error('Change set belongs to another system, client or user, or has an unsupported version.');
    return item;
  }
}

export function changeSetBinding(system: string, client: string, user: string): string {
  return createHash('sha256')
    .update(JSON.stringify([system, client, user.toUpperCase()]))
    .digest('hex');
}
