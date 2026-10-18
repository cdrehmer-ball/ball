import { describe, expect, it } from 'vitest';
import { AdtApiError } from '../../../src/adt/errors.js';
import {
  CodeChangeTracker,
  isChangeRequest,
  isCodeChangeOperation,
  observeCodeChangeRequest,
} from '../../../src/server/code-change-events.js';
import { requestContext } from '../../../src/server/context.js';

function tracker(user = 'TEST') {
  return new CodeChangeTracker(
    { system: 'https://sap.test', sapClient: '017', tool: 'SAPWrite', action: 'update', user, requestId: 'req' },
    { type: 'PROG', name: 'ZTEST', source: 'PRIVATE_SOURCE', password: 'SECRET', transport: 'DEVK900001' },
  );
}
const run = (t: CodeChangeTracker, work: () => Promise<unknown>) =>
  requestContext.run({ requestId: 'req', codeChange: t }, work);
describe('code change evidence', () => {
  it.each(['PUT', 'DELETE', 'POST'])('records accepted %s without claiming read-back verification', async (method) => {
    const t = tracker();
    await run(t, () =>
      observeCodeChangeRequest(
        method,
        '/sap/bc/adt/programs/programs/ztest/source/main?lockHandle=SECRET',
        async () => ({ statusCode: 204 }),
      ),
    );
    const event = t.finish(false)!;
    expect(event).toMatchObject({
      outcome: 'http_accepted',
      verification: 'not_performed',
      operationStatus: 'completed',
      evidence: { accepted: 1 },
      requestedObjects: [{ type: 'PROG', name: 'ZTEST' }],
    });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE_SOURCE|SECRET|lockHandle/);
    expect(t.finish(false)).toBeUndefined();
  });
  it.each([
    ['GET', '/sap/bc/adt/programs/programs/ztest'],
    ['POST', '/sap/bc/adt/checkruns'],
    ['POST', '/sap/bc/adt/abapsource/prettyprinter'],
    ['POST', '/sap/bc/adt/quickfixes/evaluation'],
    ['POST', '/sap/bc/adt/datapreview/freestyle'],
    ['POST', '/sap/bc/adt/programs/programs/ztest?_action=LOCK'],
    ['POST', '/sap/bc/adt/programs/programs/ztest?_action=UNLOCK'],
  ])('excludes %s %s', async (method, path) => {
    expect(isChangeRequest(method, path)).toBe(false);
    const t = tracker();
    await run(t, () => observeCodeChangeRequest(method, path, async () => ({ statusCode: 200 })));
    expect(t.finish(false)).toBeUndefined();
  });
  it.each([
    [423, 'rejected'],
    [403, 'rejected'],
    [500, 'unknown'],
    [408, 'unknown'],
    [429, 'unknown'],
  ])('classifies HTTP %s as %s', async (status, outcome) => {
    const t = tracker();
    const error = new AdtApiError('PRIVATE_ERROR', Number(status), '/source');
    await expect(
      run(t, () =>
        observeCodeChangeRequest('PUT', '/source', async () => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
    expect(t.finish(true)?.outcome).toBe(outcome);
  });
  it('does not mistake object names for read-only endpoint families', () => {
    expect(isChangeRequest('PUT', '/sap/bc/adt/programs/programs/validation/source/main')).toBe(true);
    expect(isChangeRequest('POST', '/sap/bc/adt/quickfixes/proposals/apply')).toBe(true);
    expect(isChangeRequest('POST', '/sap/bc/adt/refactorings?step=preview')).toBe(false);
    expect(isChangeRequest('POST', '/sap/bc/adt/refactorings?step=execute')).toBe(true);
  });
  it('reports partial operations and lost responses honestly', async () => {
    const t = tracker();
    await run(t, async () => {
      await observeCodeChangeRequest('PUT', '/source', async () => ({ statusCode: 200 }));
      await expect(
        observeCodeChangeRequest('PUT', '/source', async () => {
          throw new Error('connection lost');
        }),
      ).rejects.toThrow();
    });
    expect(t.finish(true)).toMatchObject({ outcome: 'partial', evidence: { accepted: 1, unknown: 1 } });
  });
  it('treats asynchronous acceptance as uncertain and lock-only failure as not attempted', async () => {
    const t = tracker();
    await run(t, () => observeCodeChangeRequest('POST', '/activation', async () => ({ statusCode: 202 })));
    expect(t.finish(false)?.outcome).toBe('unknown');
    expect(tracker().finish(true)?.outcome).toBe('not_attempted');
  });
  it('isolates concurrent request/user evidence', async () => {
    const a = tracker('A');
    const b = tracker('B');
    await Promise.all([
      run(a, () =>
        observeCodeChangeRequest('PUT', '/source', async () => {
          await Promise.resolve();
          return { statusCode: 200 };
        }),
      ),
      run(b, () => observeCodeChangeRequest('PUT', '/source', async () => ({ statusCode: 202 }))),
    ]);
    expect(a.finish(false)).toMatchObject({ user: 'A', evidence: { accepted: 1, unknown: 0 } });
    expect(b.finish(false)).toMatchObject({ user: 'B', evidence: { accepted: 0, unknown: 1 } });
  });
  it('selects code operations but excludes reads, configuration previews and trace controls', () => {
    for (const [tool, action] of [
      ['SAPWrite', 'batch_create'],
      ['SAPActivate', 'activate'],
      ['SAPGit', 'pull'],
      ['SAPManage', 'change_package'],
      ['SAPDiagnose', 'apply_quickfix'],
    ])
      expect(isCodeChangeOperation(tool, action)).toBe(true);
    for (const [tool, action] of [
      ['SAPRead', 'PROG'],
      ['SAPCustomizing', 'prepare'],
      ['SAPGit', 'push'],
      ['SAPTransport', 'release'],
      ['SAPDiagnose', 'trace_start'],
    ])
      expect(isCodeChangeOperation(tool, action)).toBe(false);
  });
});
