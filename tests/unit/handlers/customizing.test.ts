import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionPolicy } from '../../../src/authz/policy.js';
import { ChangeSetStore } from '../../../src/customizing/store.js';
import { CustomizingWorkflow, type Reader } from '../../../src/customizing/workflow.js';
import { SAPCustomizingSchema } from '../../../src/handlers/customizing-schema.js';
import { expandHyperfocusedArgs } from '../../../src/handlers/hyperfocused.js';

type Row = Record<string, string>;
const field = (FIELDNAME: string, KEYFLAG = '', DATATYPE = 'CHAR', LENG = '20', POSITION = '3') => ({
  FIELDNAME,
  KEYFLAG,
  DATATYPE,
  LENG,
  POSITION,
  DOMNAME: '',
});

describe('SAPCustomizing guided workflow', () => {
  let directory: string;
  let data: Record<string, Row[]>;
  let reader: Reader;
  let flow: CustomizingWorkflow;
  const input = {
    action: 'prepare' as const,
    kind: 'table' as const,
    name: 'TCONFIG',
    keys: { MANDT: '017', CODE: 'A' },
    changes: { TEXT: 'After' },
    transport: 'DEVK900003',
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'arc-customizing-'));
    data = {
      DD02L: [{ TABNAME: 'TCONFIG', TABCLASS: 'TRANSP', CONTFLAG: 'C' }],
      DD03L: [field('MANDT', 'X', 'CLNT', '3', '1'), field('CODE', 'X', 'CHAR', '2', '2'), field('TEXT')],
      TVDIR: [{ TABNAME: 'TCONFIG', AREA: 'CONFIG' }],
      DD07L: [],
      DD08L: [],
      TCONFIG: [{ MANDT: '017', CODE: 'A', TEXT: 'Before' }],
      E070: [{ TRKORR: 'DEVK900003', STRKORR: '', TRSTATUS: 'D', TRFUNCTION: 'W' }],
      E070C: [{ CLIENT: '017' }],
      E071: [{ TRKORR: 'DEVK900003', PGMID: 'R3TR', OBJECT: 'TABU', OBJ_NAME: 'TCONFIG' }],
      E071K: [{ TRKORR: 'DEVK900003', OBJNAME: 'TCONFIG', TABKEY: '017A ' }],
    };
    reader = {
      runTableQuery: vi.fn(async (name: string, opts?: Parameters<Reader['runTableQuery']>[1]) => {
        let rows = data[name] ?? [];
        if (name === 'E070' && opts?.where?.some((w) => w.field === 'STRKORR')) rows = [];
        return { columns: Object.keys(rows[0] ?? {}), rows: rows.slice(0, opts?.maxRows) };
      }),
    };
    flow = new CustomizingWorkflow(reader, 'https://sap.test', '017', 'TEST', new ChangeSetStore(directory));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it('prepares, guides and verifies an existing standard-table update without writes', async () => {
    const set = await flow.prepare(input);
    expect(data.TCONFIG[0].TEXT).toBe('Before');
    expect((await flow.guide(set.id)).transaction).toBe('SM30');
    data.TCONFIG[0].TEXT = 'After';
    const verified = await flow.verify(set.id, input.transport);
    expect(verified.values.outcome).toBe('verified');
    expect(verified.transport).toMatchObject({ outcome: 'verified' });
    expect(Object.keys(reader)).toEqual(['runTableQuery']);
  });
  it('rejects stale guidance and reports partial saves separately from transport evidence', async () => {
    data.DD03L.push(field('OTHER'));
    data.TCONFIG[0].OTHER = 'Old';
    const set = await flow.prepare({ ...input, changes: { TEXT: 'After', OTHER: 'New' } });
    data.TCONFIG[0].TEXT = 'After';
    await expect(flow.guide(set.id)).rejects.toThrow('STALE_CHANGE_SET');
    data.E071 = [];
    const result = await flow.verify(set.id, input.transport);
    expect(result.values.outcome).toBe('partially_verified');
    expect(result.transport).toMatchObject({ outcome: 'mismatch' });
  });
  it('rejects missing keys, key/client changes, creation, unknown fields and oversized values', async () => {
    await expect(flow.prepare({ ...input, keys: { CODE: 'A' } })).rejects.toThrow('every key');
    await expect(flow.prepare({ ...input, keys: { MANDT: '100', CODE: 'A' } })).rejects.toThrow('client');
    for (const changes of [{ CODE: 'B' }, { MANDT: '100' }, { UNKNOWN: 'x' }, { TEXT: 'x'.repeat(21) }] as Row[])
      await expect(flow.prepare({ ...input, changes })).rejects.toThrow();
    data.TCONFIG = [];
    await expect(flow.prepare(input)).rejects.toThrow('existing row');
  });
  it('does not confuse a Z business table with customising', async () => {
    data.DD02L[0].CONTFLAG = 'A';
    await expect(flow.prepare({ ...input, name: 'ZBUSINESS' })).rejects.toThrow('Delivery class');
  });
  it('fails closed on unknown maintenance, ambiguous views and denied metadata reads', async () => {
    data.TVDIR = [];
    await expect(flow.prepare(input)).rejects.toThrow('maintenance route');
    data.TVDIR = [{ TABNAME: 'TCONFIG', AREA: 'CONFIG' }];
    data.DD27S = [
      { VIEWFIELD: 'CODE', TABNAME: 'A', FIELDNAME: 'CODE' },
      { VIEWFIELD: 'TEXT', TABNAME: 'B', FIELDNAME: 'TEXT' },
    ];
    await expect(flow.prepare({ ...input, kind: 'view' })).rejects.toThrow('mapping');
    vi.mocked(reader.runTableQuery).mockRejectedValue(new Error('Blocked data source'));
    await expect(flow.prepare(input)).rejects.toThrow('Blocked data source');
  });
  it('bounds discovery and advertises untested capabilities honestly', async () => {
    data.DD02L = Array.from({ length: 4 }, (_, i) => ({ TABNAME: `T${i}`, TABCLASS: 'TRANSP', CONTFLAG: 'C' }));
    const result = await flow.discover({ action: 'discover', query: 'T*', maxRows: 2 });
    expect(result).toMatchObject({ truncated: true });
    expect('objects' in result && result.objects).toHaveLength(2);
    await expect(flow.discover({ action: 'discover', query: '**' })).rejects.toThrow('bounded');
  });
  it('requires existing status/language keys and permits only profile text fields', async () => {
    data.DD03L = [
      field('MANDT', 'X', 'CLNT', '3', '1'),
      field('STSMA', 'X'),
      field('SPRAS', 'X', 'LANG', '1'),
      field('TXT'),
    ];
    data.TJ20T = [{ MANDT: '017', STSMA: 'ZPROFILE', SPRAS: 'E', TXT: 'Before' }];
    const set = await flow.prepare({
      ...input,
      kind: 'status_profile',
      name: 'ZPROFILE',
      keys: { MANDT: '017', STSMA: 'ZPROFILE', SPRAS: 'E' },
      changes: { TXT: 'After' },
    });
    expect((await flow.guide(set.id)).transaction).toBe('BS02');
    data.DD03L.push(field('CONTROL'));
    data.TJ20T[0].CONTROL = 'X';
    await expect(
      flow.prepare({ ...input, kind: 'status_profile', name: 'ZPROFILE', keys: set.keys, changes: { CONTROL: 'Y' } }),
    ).rejects.toThrow('Only status/profile texts');
  });
  it('keeps undecodable/wildcard key evidence as partial', async () => {
    const set = await flow.prepare(input);
    data.E071K[0].TABKEY = '017*';
    expect((await flow.verify(set.id, input.transport)).transport).toMatchObject({ outcome: 'partially_verified' });
  });
  it('checks domain and check-table constraints', async () => {
    data.DD03L[2].DOMNAME = 'TEXTDOMAIN';
    data.DD07L = [{ DOMVALUE_L: 'Allowed', DOMVALUE_H: '' }];
    await expect(flow.prepare(input)).rejects.toThrow('domain');
    data.DD07L = [];
    data.DD08L = [{ CHECKTABLE: 'TCHECK' }];
    data.DD05S = [{ FORTABLE: 'TCONFIG', FORKEY: 'TEXT', CHECKFIELD: 'TEXT' }];
    await expect(flow.prepare(input)).rejects.toThrow('check-table entry');
  });
  it('uses raw comma-separated delivery classes for the permitted query builder', async () => {
    await flow.discover({ action: 'discover', query: 'T*' });
    expect(reader.runTableQuery).toHaveBeenCalledWith(
      'DD02L',
      expect.objectContaining({ where: expect.arrayContaining([{ field: 'CONTFLAG', op: 'IN', value: 'C,G' }]) }),
    );
  });
  it('binds snapshots to system, client and user', async () => {
    const set = await flow.prepare(input);
    const other = new CustomizingWorkflow(reader, 'https://sap.test', '017', 'OTHER', new ChangeSetStore(directory));
    await expect(other.guide(set.id)).rejects.toThrow('another system');
    await expect(new ChangeSetStore(directory).load('../outside', '')).rejects.toThrow('Invalid');
  });
  it('requires actual transport on verification and routes hyperfocused calls under data policy', () => {
    expect(
      SAPCustomizingSchema.safeParse({ action: 'verify', changeSetId: '5b3dc934-a143-4590-861b-3b7f70eb4247' }).success,
    ).toBe(false);
    expect(SAPCustomizingSchema.safeParse({ ...input, action: 'delete' }).success).toBe(false);
    expect(expandHyperfocusedArgs({ action: 'customizing', params: input })).toMatchObject({
      toolName: 'SAPCustomizing',
      expandedArgs: input,
    });
    expect(getActionPolicy('SAPCustomizing', 'prepare')?.scope).toBe('data');
  });
});
