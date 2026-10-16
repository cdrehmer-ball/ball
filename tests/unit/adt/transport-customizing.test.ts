import { describe, expect, it, vi } from 'vitest';
import type { AdtHttpClient } from '../../../src/adt/http.js';
import { defaultSafetyConfig } from '../../../src/adt/safety.js';
import { collectTransportNodes, getTransportDetails, parseTransportList } from '../../../src/adt/transport.js';

const xml = `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm">
<tm:workbench><tm:modifiable><tm:request tm:number="DEVK900001" tm:status="D"/></tm:modifiable>
<tm:released><tm:request tm:number="DEVK900002" tm:status="R"/></tm:released></tm:workbench>
<tm:customizing><tm:modifiable><tm:request tm:number="DEVK900003" tm:status="D">
<tm:abap_object tm:pgmid="R3TR" tm:type="TABU" tm:name="ZCONFIG"/>
<tm:task tm:number="DEVK900004" tm:status="D"><tm:abap_object tm:pgmid="R3TR" tm:type="BSVS" tm:name="ZPROFILE"/></tm:task>
</tm:request></tm:modifiable></tm:customizing></tm:root>`;

describe('CTS all-branch parsing regression', () => {
  it('collects every category/status and preserves task/request objects', () => {
    const r = parseTransportList(xml, '/cts');
    expect(r.map((x) => x.id)).toEqual(['DEVK900001', 'DEVK900002', 'DEVK900003']);
    expect(r.map((x) => x.type)).toEqual(['K', 'K', 'W']);
    expect(r[2].requestObjects?.[0].name).toBe('ZCONFIG');
    expect(r[2].tasks[0].objects[0].name).toBe('ZPROFILE');
  });
  it('honours explicit type, supports namespace variations and empty trees', () => {
    expect(parseTransportList(xml.replaceAll('tm:', 'cts:').replace('xmlns:tm', 'xmlns:cts'), '/cts')).toHaveLength(3);
    expect(
      parseTransportList('<root><workbench><request number="X" type="T"/></workbench></root>', '/cts')[0].type,
    ).toBe('T');
    expect(parseTransportList('<root/>', '/cts')).toEqual([]);
    expect(() => parseTransportList('<root><request></root>', '/cts')).toThrow('Invalid transport XML');
    expect(() => parseTransportList('<html/>', '/cts')).toThrow('unexpected CTS response');
  });
  it('resolves a nested task and its parent without changing mutation lookup', async () => {
    const http = { get: vi.fn().mockResolvedValue({ body: xml }) } as unknown as AdtHttpClient;
    expect(await getTransportDetails(http, defaultSafetyConfig(), 'DEVK900004')).toMatchObject({
      id: 'DEVK900004',
      kind: 'task',
      parentId: 'DEVK900003',
      parentType: 'W',
    });
    expect(await getTransportDetails(http, defaultSafetyConfig(), 'MISSING')).toBeNull();
  });
  it('reads standalone tasks and preserves HTTP errors', async () => {
    const get = vi.fn().mockResolvedValue({
      body: '<root><task number="DEVK900004"><abap_object type="BSVS" name="ZPROFILE"/></task></root>',
    });
    const http = { get } as unknown as AdtHttpClient;
    expect(await getTransportDetails(http, defaultSafetyConfig(), 'DEVK900004')).toMatchObject({
      kind: 'task',
      parentId: null,
      objects: [{ type: 'BSVS', name: 'ZPROFILE' }],
    });
    const failure = new Error('HTTP 403');
    get.mockRejectedValue(failure);
    await expect(getTransportDetails(http, defaultSafetyConfig(), 'DEVK900004')).rejects.toBe(failure);
  });
  it('collects nested arrays and does not descend into already selected requests', () => {
    expect(
      collectTransportNodes(
        { root: [{ a: { request: [{ id: 1 }, { id: 2 }] } }, { b: { request: { id: 3 } } }] },
        'request',
      ),
    ).toHaveLength(3);
  });
});
