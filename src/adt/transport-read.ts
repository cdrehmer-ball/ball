import { XMLValidator } from 'fast-xml-parser';
import { AdtApiError } from './errors.js';
import type { AdtHttpClient } from './http.js';
import { checkTransport, type SafetyConfig } from './safety.js';
import { CTS_CONTENT_TYPE_ORGANIZER } from './transport.js';
import type { TransportObject, TransportRequest, TransportTask } from './types.js';
import { findDeepNodes, parseXml } from './xml-parser.js';

export function parseTransportList(xml: string, path: string): TransportRequest[] {
  if (XMLValidator.validate(xml) !== true) throw new AdtApiError('Invalid transport XML response.', 200, path);
  const parsed = parseXml(xml);
  if (!Object.hasOwn(parsed, 'root')) {
    const explanation =
      'Transport API unavailable or unexpected CTS response: no transport organizer document was returned. This response does not establish an empty list or a missing request.';
    const error = new AdtApiError(explanation, 200, path);
    // Minimal mode hides the message; extraHint preserves this fixed explanation, never SAP response text.
    error.extraHint = explanation;
    throw error;
  }
  const requests = collectTransportNodes(parsed, 'request');

  return requests.map((req) => {
    const tasks: TransportTask[] = findDeepNodes(req, 'task').map((t) => {
      // Objects are collected per <task>. The ADT transportorganizer XML nests <abap_object>
      // under <task>, not directly under <request>, so request-level entries (rare, e.g. some
      // non-workbench request shapes) are not represented here — which is why `removeLockedObjects`
      // in deleteTransport iterates tasks. `tm:lock_status` is "X" when locked; absent on NW 7.5x.
      const objects: TransportObject[] = findDeepNodes(t, 'abap_object').map((o) => ({
        pgmid: String(o['@_pgmid'] ?? ''),
        type: String(o['@_type'] ?? ''),
        name: String(o['@_name'] ?? ''),
        wbtype: String(o['@_wbtype'] ?? ''),
        description: String(o['@_obj_desc'] ?? o['@_obj_info'] ?? ''),
        locked: String(o['@_lock_status'] ?? '') === 'X',
        position: String(o['@_position'] ?? '000000'),
      }));

      return {
        id: String(t['@_number'] ?? ''),
        description: String(t['@_desc'] ?? ''),
        owner: String(t['@_owner'] ?? ''),
        status: String(t['@_status'] ?? ''),
        objects,
      };
    });

    // Request-level <tm:abap_object> children, read STRUCTURALLY.
    //
    // findDeepNodes must not be used here: it only stops early when the key is a DIRECT
    // property, and on the common shape (objects only under tasks) it recurses into <tm:task>
    // and returns the first task's objects — which would duplicate them onto the request and
    // stamp them with the request id instead of their task's.
    const directObjects = req.abap_object;
    const requestObjects: TransportObject[] = (
      Array.isArray(directObjects) ? directObjects : directObjects ? [directObjects] : []
    )
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o) => ({
        pgmid: String(o['@_pgmid'] ?? ''),
        type: String(o['@_type'] ?? ''),
        name: String(o['@_name'] ?? ''),
        wbtype: String(o['@_wbtype'] ?? ''),
        description: String(o['@_obj_desc'] ?? o['@_obj_info'] ?? ''),
        locked: String(o['@_lock_status'] ?? '') === 'X',
        position: String(o['@_position'] ?? '000000'),
      }));

    return {
      id: String(req['@_number'] ?? ''),
      description: String(req['@_desc'] ?? ''),
      owner: String(req['@_owner'] ?? ''),
      status: String(req['@_status'] ?? ''),
      type: String(req['@_type'] ?? req['@_categoryType'] ?? ''),
      target: String(req['@_target'] ?? ''),
      targetDesc: String(req['@_target_desc'] ?? ''),
      tasks,
      ...(requestObjects.length ? { requestObjects } : {}),
    };
  });
}

/** Collect every CTS category/status branch without changing the shared first-match helper. */
export function collectTransportNodes(node: unknown, key: string, category = ''): Array<Record<string, unknown>> {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item) => collectTransportNodes(item, key, category));
  const result: Array<Record<string, unknown>> = [];
  for (const [name, value] of Object.entries(node)) {
    const next = name === 'customizing' ? 'W' : name === 'workbench' ? 'K' : category;
    if (name === key) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item && typeof item === 'object') result.push({ ...item, '@_categoryType': next });
      }
    } else if (!name.startsWith('@_')) result.push(...collectTransportNodes(value, key, next));
  }
  return result;
}

/** Read-only request/task lookup. Mutation callers retain the request-only getTransport API. */
export async function getTransportDetails(http: AdtHttpClient, safety: SafetyConfig, id: string) {
  checkTransport(safety, id, 'GetTransport', false);
  const url = `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}`;
  const response = await http.get(url, { Accept: CTS_CONTENT_TYPE_ORGANIZER });
  const requests = parseTransportList(response.body, url);
  const request = requests.find((r) => r.id === id);
  if (request) return request;
  for (const parent of requests) {
    const task = parent.tasks.find((t) => t.id === id);
    if (task) return { ...task, kind: 'task' as const, parentId: parent.id, parentType: parent.type };
  }
  const standalone = collectTransportNodes(parseXml(response.body), 'task').find((t) => t['@_number'] === id);
  if (standalone) {
    return {
      id: String(standalone['@_number']),
      kind: 'task' as const,
      parentId: null,
      description: String(standalone['@_desc'] ?? ''),
      owner: String(standalone['@_owner'] ?? ''),
      status: String(standalone['@_status'] ?? ''),
      objects: collectTransportNodes(standalone, 'abap_object').map((o) => ({
        pgmid: String(o['@_pgmid'] ?? ''),
        type: String(o['@_type'] ?? ''),
        name: String(o['@_name'] ?? ''),
        wbtype: String(o['@_wbtype'] ?? ''),
        description: String(o['@_obj_desc'] ?? o['@_obj_info'] ?? ''),
        locked: String(o['@_lock_status'] ?? '') === 'X',
        position: String(o['@_position'] ?? '000000'),
      })),
    };
  }
  return null;
}
