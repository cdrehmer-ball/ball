import type { AdtClient } from '../adt/client.js';
import type { CustomizingInput } from '../handlers/customizing-schema.js';
import { type ChangeSet, ChangeSetStore, changeSetBinding } from './store.js';

type Row = Record<string, string>;
type Filter = { field: string; op: string; value?: string };
export type Reader = Pick<AdtClient, 'runTableQuery'>;
interface Field {
  name: string;
  key: boolean;
  type: string;
  length: number;
  domain: string;
  position: number;
}
interface Model {
  table: string;
  fields: Field[];
  route?: 'BS02' | 'SM30';
  preparable: boolean;
  limitations: string[];
  deliveryClass?: string;
}
const eq = (field: string, value: string): Filter => ({ field, op: '=', value });
const active = [eq('AS4LOCAL', 'A'), eq('AS4VERS', '0000')];
const IDENTIFIER = /^[A-Z0-9_/]{1,40}$/;
const supportedTypes = new Set(['CHAR', 'NUMC', 'DATS', 'TIMS', 'LANG', 'CLNT']);
const textFields = new Set(['TXT', 'TXT04', 'TXT30']);

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error('Invalid SAP identifier.');
  return value;
}
function filters(values: Row): Filter[] {
  return Object.entries(values).map(([k, v]) => eq(identifier(k), v));
}
function assertKeys(model: Model, keys: Row, client: string) {
  const wanted = model.fields
    .filter((f) => f.key)
    .map((f) => f.name)
    .sort();
  if (!wanted.length || JSON.stringify(wanted) !== JSON.stringify(Object.keys(keys).sort()))
    throw new Error('Supply every key field exactly, including client and language where present.');
  for (const f of model.fields.filter((f) => f.type === 'CLNT'))
    if (keys[f.name] !== client) throw new Error('The row client must equal the connected SAP client.');
}

/** No raw HTTP/SQL or write interface is exposed to the workflow. runTableQuery enforces the data ceiling. */
export class CustomizingWorkflow {
  private binding: string;
  constructor(
    private reader: Reader,
    private system: string,
    private client: string,
    user: string,
    private store = new ChangeSetStore(),
  ) {
    this.binding = changeSetBinding(system, client, user);
  }
  private async query(table: string, where: Filter[], maxRows = 101, columns?: string[]) {
    return this.reader.runTableQuery(identifier(table), { where, maxRows, columns });
  }
  private async fields(table: string): Promise<Field[]> {
    const r = await this.query('DD03L', [eq('TABNAME', table), ...active], 501, [
      'FIELDNAME',
      'KEYFLAG',
      'DATATYPE',
      'LENG',
      'DOMNAME',
      'POSITION',
    ]);
    if (!r.rows.length || r.rows.length > 500)
      throw new Error('Field metadata unavailable or exceeds the 500-field limit.');
    if (r.rows.some((f) => !IDENTIFIER.test(f.FIELDNAME)))
      throw new Error('Unresolved include/append metadata; guided update unavailable.');
    return r.rows
      .map((f) => ({
        name: f.FIELDNAME,
        key: f.KEYFLAG === 'X',
        type: f.DATATYPE,
        length: Number(f.LENG),
        domain: f.DOMNAME,
        position: Number(f.POSITION),
      }))
      .sort((a, b) => a.position - b.position);
  }
  async model(input: CustomizingInput): Promise<Model> {
    const name = identifier(input.name!);
    const table = input.kind === 'status_profile' ? (input.textTable ?? 'TJ20T') : name;
    const fields = await this.fields(table);
    const limitations: string[] = [];
    const headers = await this.query('DD02L', [eq('TABNAME', table), ...active], 2, [
      'TABNAME',
      'TABCLASS',
      'CONTFLAG',
    ]);
    const header = headers.rows.length === 1 ? headers.rows[0] : undefined;
    let route: Model['route'];
    if (input.kind === 'status_profile') {
      if (fields.some((f) => f.name === 'STSMA' && f.key) && fields.some((f) => textFields.has(f.name))) route = 'BS02';
      else limitations.push('Status-profile text metadata is not recognised on this system.');
    } else {
      const maintenance = await this.query('TVDIR', [eq('TABNAME', table)], 2, ['TABNAME', 'AREA']);
      if (maintenance.rows.length === 1 && maintenance.rows[0].AREA) route = 'SM30';
      else limitations.push('No unambiguous generated maintenance route was found.');
      if (!header || !['C', 'G'].includes(header.CONTFLAG))
        limitations.push('Delivery class does not establish supported customising (C/G).');
      if (input.kind === 'view' || header?.TABCLASS === 'VIEW') {
        // Maintenance views may span several tables and are not necessarily SELECT-readable.
        // Only identity mappings onto ONE backing customising table are admitted in this release.
        const mapping = await this.query('DD27S', [eq('VIEWNAME', table), ...active], 501, [
          'VIEWFIELD',
          'TABNAME',
          'FIELDNAME',
        ]);
        const tables = [...new Set(mapping.rows.map((r) => r.TABNAME))];
        if (
          !mapping.rows.length ||
          mapping.rows.length > 500 ||
          tables.length !== 1 ||
          fields.some((f) => !mapping.rows.some((m) => m.VIEWFIELD === f.name && m.FIELDNAME === f.name))
        )
          limitations.push('View backing-field mapping is complex or incomplete; preparation is unsupported.');
        else {
          const backingFields = await this.fields(tables[0]);
          if (
            backingFields
              .filter((f) => f.key)
              .some(
                (f) => !fields.some((v) => v.name === f.name && v.key && v.type === f.type && v.length === f.length),
              )
          )
            limitations.push('View does not expose the complete backing-table key.');
          const base = await this.query('DD02L', [eq('TABNAME', tables[0]), ...active], 2, ['CONTFLAG']);
          if (base.rows.length !== 1 || !['C', 'G'].includes(base.rows[0].CONTFLAG))
            limitations.push('Backing table is not established as customising.');
        }
      }
    }
    if (!fields.some((f) => f.key)) limitations.push('No complete key is available.');
    return {
      table,
      fields,
      route,
      preparable: !!route && !limitations.length,
      limitations,
      deliveryClass: header?.CONTFLAG,
    };
  }
  private rowScope(input: CustomizingInput, model: Model): Row {
    const keys = { ...input.keys };
    for (const key of Object.keys(keys))
      if (!model.fields.some((f) => f.name === key)) throw new Error('Unknown filter field.');
    for (const f of model.fields.filter((f) => f.type === 'CLNT')) {
      if (keys[f.name] !== undefined && keys[f.name] !== this.client)
        throw new Error('Cross-client selection is not supported.');
      keys[f.name] = this.client;
    }
    if (input.kind === 'status_profile') {
      if (keys.STSMA && keys.STSMA !== input.name) throw new Error('STSMA must match the selected status profile.');
      keys.STSMA = input.name!;
    }
    return keys;
  }
  async read(input: CustomizingInput) {
    const model = await this.model(input);
    const limit = input.maxRows ?? 50;
    const rows = await this.query(model.table, filters(this.rowScope(input, model)), limit + 1);
    return {
      system: this.system,
      client: this.client,
      object: input.name,
      ...model,
      capabilities: { discoverable: true, readable: true, preparable: model.preparable, verifiable: model.preparable },
      rows: rows.rows.slice(0, limit),
      truncated: rows.rows.length > limit,
      hint:
        rows.rows.length > limit ? 'Narrow keys to read omitted rows; this is not a complete inventory.' : undefined,
      validation: 'Metadata checks are preliminary. SAP maintenance performs final business validation.',
    };
  }
  async discover(input: CustomizingInput) {
    if (input.name) return this.read({ ...input, kind: input.kind ?? 'table' });
    const pattern = input.query!.replace(/\*/g, '%');
    if (!/[A-Z0-9]/.test(pattern))
      throw new Error('Use a bounded name pattern containing at least one letter or digit.');
    const limit = input.maxRows ?? 50;
    const r = await this.query(
      'DD02L',
      [{ field: 'TABNAME', op: 'LIKE', value: pattern }, ...active, { field: 'CONTFLAG', op: 'IN', value: 'C,G' }],
      limit + 1,
      ['TABNAME', 'TABCLASS', 'CONTFLAG'],
    );
    return {
      objects: r.rows.slice(0, limit).map((r) => ({
        name: r.TABNAME,
        kind: r.TABCLASS === 'VIEW' ? 'view' : 'table',
        deliveryClass: r.CONTFLAG,
        capabilities: {
          discoverable: true,
          readable: 'not_checked',
          preparable: 'not_checked',
          verifiable: 'not_checked',
        },
      })),
      truncated: r.rows.length > limit,
      completeness:
        'Bounded C/G DDIC candidates, not an exhaustive inventory of all SAP customising. Narrow query if truncated.',
    };
  }
  private async one(model: Model, keys: Row): Promise<Row> {
    assertKeys(model, keys, this.client);
    const r = await this.query(model.table, filters(keys), 2);
    if (r.rows.length !== 1)
      throw new Error('Expected exactly one existing row; creation/deletion and ambiguous selections are unsupported.');
    if (model.fields.some((f) => !Object.hasOwn(r.rows[0], f.name))) throw new Error('Row projection is incomplete.');
    return r.rows[0];
  }
  private async validate(model: Model, keys: Row, changes: Row, kind: string) {
    for (const [name, value] of Object.entries(changes)) {
      const field = model.fields.find((f) => f.name === name);
      if (!field || field.key || field.type === 'CLNT' || field.type === 'LANG')
        throw new Error('Unknown, key, client or language field cannot be changed.');
      if (kind === 'status_profile' && !textFields.has(name))
        throw new Error('Only status/profile texts are supported.');
      if (!supportedTypes.has(field.type) || !Number.isFinite(field.length) || field.length < 1)
        throw new Error('Field type or length is not supported for guided updates.');
      if (value.length > field.length) throw new Error('Proposed value exceeds the DDIC field length.');
      if (field.type === 'NUMC' && !/^\d+$/.test(value)) throw new Error('NUMC requires digits.');
      if (field.type === 'DATS' && !validDate(value))
        throw new Error('DATS requires a valid YYYYMMDD date or 00000000.');
      if (field.type === 'TIMS' && !/^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(value))
        throw new Error('TIMS requires HHMMSS.');
      if (field.domain) {
        const fixed = await this.query('DD07L', [eq('DOMNAME', field.domain), ...active], 101, [
          'DOMVALUE_L',
          'DOMVALUE_H',
        ]);
        if (fixed.rows.length > 100) throw new Error('Domain constraints exceed validation limit.');
        if (
          fixed.rows.length &&
          !fixed.rows.some((r) =>
            r.DOMVALUE_H ? value >= r.DOMVALUE_L && value <= r.DOMVALUE_H : value === r.DOMVALUE_L,
          )
        )
          throw new Error('Proposed value does not satisfy domain fixed values.');
      }
      // Resolve foreign-key assignments rather than guessing joins from a check-table name.
      const check = await this.query('DD08L', [eq('TABNAME', model.table), eq('FIELDNAME', name), ...active], 2, [
        'CHECKTABLE',
      ]);
      if (check.rows.length > 1) throw new Error('Ambiguous check-table constraint.');
      const checkTable = check.rows[0]?.CHECKTABLE;
      if (checkTable && checkTable !== '*') {
        const mapping = await this.query('DD05S', [eq('TABNAME', model.table), eq('FIELDNAME', name), ...active], 41, [
          'FORTABLE',
          'FORKEY',
          'CHECKFIELD',
        ]);
        const where: Filter[] = [];
        if (!mapping.rows.length || mapping.rows.length > 40)
          throw new Error('Check-table mapping is unavailable or too complex.');
        for (const m of mapping.rows) {
          const candidate = { ...keys, ...changes }[m.FORKEY];
          if (m.FORTABLE !== model.table || candidate === undefined || !IDENTIFIER.test(m.CHECKFIELD))
            throw new Error('Check-table constraint requires unresolved fields; use SAP maintenance validation.');
          where.push(eq(m.CHECKFIELD, candidate));
        }
        if (!(await this.query(checkTable, where, 1)).rows.length)
          throw new Error('Proposed values have no matching check-table entry.');
      }
    }
  }
  async prepare(input: CustomizingInput) {
    const model = await this.model(input);
    if (!model.preparable) throw new Error(`Preparation unavailable: ${model.limitations.join(' ')}`);
    const keys = input.keys!;
    // Unlike reads, preparation never silently fills omitted keys.
    assertKeys(model, keys, this.client);
    if (input.kind === 'status_profile' && keys.STSMA !== input.name)
      throw new Error('STSMA must match the selected profile.');
    const before = await this.one(model, keys);
    await this.validate(model, { ...before, ...keys }, input.changes!, input.kind!);
    if (Object.entries(input.changes!).every(([k, v]) => before[k] === v))
      throw new Error('No changed values were supplied.');
    await this.checkTransport(input.transport!);
    return this.store.save({
      binding: this.binding,
      system: this.system,
      client: this.client,
      object: { kind: input.kind!, name: input.name!, textTable: input.textTable },
      table: model.table,
      keys,
      before,
      changes: input.changes!,
      capturedAt: new Date().toISOString(),
      transport: input.transport!,
    });
  }
  private async checkTransport(id: string) {
    const entry = await this.query('E070', [eq('TRKORR', id)], 2, ['TRKORR', 'STRKORR', 'TRSTATUS', 'TRFUNCTION']);
    if (entry.rows.length !== 1 || !['D', 'L'].includes(entry.rows[0].TRSTATUS))
      throw new Error('A single modifiable transport/task must be supplied.');
    const task = entry.rows[0];
    const parentId = task.STRKORR || id;
    const parent = parentId === id ? task : (await this.query('E070', [eq('TRKORR', parentId)], 2)).rows[0];
    if (parent?.TRFUNCTION !== 'W' || !['D', 'L'].includes(parent.TRSTATUS))
      throw new Error('The parent must be a modifiable Customising request (W).');
    const source = await this.query('E070C', [eq('TRKORR', parentId)], 2, ['CLIENT']);
    if (source.rows.length !== 1 || source.rows[0].CLIENT !== this.client)
      throw new Error('Cannot establish that the request source client matches the connection.');
    return { id, parentId };
  }
  private async load(id: string) {
    const set = await this.store.load(id, this.binding);
    // Validate persisted fields again: a snapshot is data, not authority.
    identifier(set.object.name);
    identifier(set.table);
    identifier(set.transport);
    const model = await this.model({ action: 'read', ...set.object });
    if (!model.preparable || model.table !== set.table) throw new Error('Object capabilities changed; prepare again.');
    const current = await this.one(model, set.keys);
    await this.validate(model, { ...current, ...set.keys }, set.changes, set.object.kind);
    return { set, model, current };
  }
  async guide(id: string) {
    const { set, model, current } = await this.load(id);
    if (model.fields.some((f) => current[f.name] !== set.before[f.name]))
      throw new Error('STALE_CHANGE_SET: original row changed. Read and prepare again.');
    await this.checkTransport(set.transport);
    return {
      changeSetId: id,
      system: this.system,
      client: this.client,
      transaction: model.route,
      before: set.before,
      changes: set.changes,
      keys: set.keys,
      steps: [
        `Log on to ${this.system}, client ${this.client}, using your authorised SAP user.`,
        model.route === 'BS02'
          ? `Open BS02 and select status profile ${set.object.name}. Select the existing status/language identified by the keys.`
          : `Open SM30 for ${set.object.name}. Select the existing row using every supplied key.`,
        'Compare the displayed values to the captured before values. Stop if they differ; do not create a new entry.',
        'Apply only the proposed fields. For translations, use the existing language entry in SAP maintenance.',
        `Save through SAP and select request/task ${set.transport}. SAP performs business validation, locking and recording.`,
        'Call SAPCustomizing verify with this changeSetId and the actual request/task used.',
      ],
      warning:
        'No SAP changes have been made. A concurrent edit after this check is still possible; recheck in SAP GUI.',
    };
  }
  async verify(id: string, transport: string) {
    const { set, model, current } = await this.load(id);
    const fields = Object.entries(set.changes).map(([field, expected]) => ({
      field,
      expected,
      actual: current[field],
      matches: current[field] === expected,
    }));
    const matches = fields.filter((f) => f.matches).length;
    const values = matches === fields.length ? 'verified' : matches ? 'partially_verified' : 'mismatch';
    let recording: unknown;
    try {
      recording = await this.transportEvidence(set, model, transport);
    } catch {
      recording = {
        outcome: 'unverifiable',
        reason: 'Transport evidence could not be read with current permissions/capabilities.',
      };
    }
    return {
      changeSetId: id,
      checkedAt: new Date().toISOString(),
      values: { outcome: values, fields },
      transport: recording,
      provenance:
        'Compared with the locally captured baseline. Matching current values do not prove who changed them. Existing CTS entries do not prove these field edits were recorded.',
    };
  }
  private async transportEvidence(set: ChangeSet, model: Model, id: string) {
    identifier(id);
    const e070 = await this.query('E070', [eq('TRKORR', id)], 2, ['TRKORR', 'STRKORR', 'TRFUNCTION']);
    if (e070.rows.length !== 1) return { outcome: 'unverifiable', reason: 'Request/task not resolved.' };
    const tasks = e070.rows[0].STRKORR ? [] : (await this.query('E070', [eq('STRKORR', id)], 21, ['TRKORR'])).rows;
    const ids = [id, ...tasks.slice(0, 20).map((t) => t.TRKORR)];
    const evidence: Row[] = [];
    let bounded = tasks.length > 20;
    for (const request of ids) {
      const entries = await this.query('E071', [eq('TRKORR', request)], 101, ['TRKORR', 'PGMID', 'OBJECT', 'OBJ_NAME']);
      bounded ||= entries.rows.length > 100;
      evidence.push(
        ...entries.rows
          .slice(0, 100)
          .filter((r) =>
            set.object.kind === 'status_profile'
              ? r.OBJECT === 'BSVS' && r.OBJ_NAME === set.object.name
              : ['TABU', 'VDAT'].includes(r.OBJECT) && [set.table, set.object.name].includes(r.OBJ_NAME),
          ),
      );
    }
    if (!evidence.length)
      return {
        outcome: bounded ? 'unverifiable' : 'mismatch',
        entries: [],
        truncated: bounded,
        reason: 'No matching object found in the inspected request/task entries.',
      };
    if (set.object.kind === 'status_profile')
      return {
        outcome: 'partially_verified',
        entries: evidence,
        reason: 'Status profile object is recorded; CTS does not establish the individual text-field change.',
      };
    const keyEvidence: Row[] = [];
    for (const request of ids) {
      const rows = await this.query('E071K', [eq('TRKORR', request), eq('OBJNAME', set.table)], 101);
      bounded ||= rows.rows.length > 100;
      keyEvidence.push(...rows.rows.slice(0, 100));
    }
    const keyFields = model.fields.filter((f) => f.key);
    const decodable = keyFields.every((f) => ['CHAR', 'NUMC', 'CLNT', 'LANG'].includes(f.type) && f.length > 0);
    const expected = decodable ? keyFields.map((f) => set.keys[f.name].padEnd(f.length, ' ')).join('') : undefined;
    const matched = expected !== undefined && keyEvidence.some((r) => r.TABKEY?.trimEnd() === expected.trimEnd());
    return {
      outcome: matched ? 'verified' : 'partially_verified',
      entries: evidence,
      keys: keyEvidence,
      truncated: bounded,
      coverage: matched
        ? 'Object and exact supported row key are recorded; field-level attribution is unproven.'
        : 'Object found; row-key coverage not established. Raw wildcard/unsupported keys are preserved, not guessed.',
    };
  }
}

function validDate(value: string) {
  if (value === '00000000') return true;
  if (!/^\d{8}$/.test(value)) return false;
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10).replaceAll('-', '') === value;
}
