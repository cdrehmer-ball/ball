import type { AdtClient } from '../adt/client.js';
import { checkOperation, OperationType } from '../adt/safety.js';
import { getTransportDetails } from '../adt/transport.js';
import { CustomizingWorkflow } from '../customizing/workflow.js';
import type { ServerConfig } from '../server/types.js';
import { SAPCustomizingSchema } from './customizing-schema.js';
import { textResult, toolJson } from './shared.js';

export async function handleSAPCustomizing(client: AdtClient, args: Record<string, unknown>, config: ServerConfig) {
  if (config.transport !== 'stdio' || config.systemType === 'btp' || config.ppEnabled)
    throw new Error('SAPCustomizing is a local, single-user stdio workflow in this release.');
  checkOperation(client.safety, OperationType.Query, 'Customizing');
  const input = SAPCustomizingSchema.parse(args);
  const system = new URL(config.url).origin;
  const workflow = new CustomizingWorkflow(client, system, client.sapClient, client.username);
  let result: unknown;
  if (input.action === 'discover' && input.transport) {
    if (config.featureTransport === 'off') throw new Error('Transport capability is disabled.');
    const transport = await getTransportDetails(client.http, client.safety, input.transport);
    const objects = transport
      ? 'tasks' in transport
        ? [...(transport.requestObjects ?? []), ...transport.tasks.flatMap((t) => t.objects)]
        : transport.objects
      : [];
    const limit = input.maxRows ?? 50;
    result = {
      system,
      client: client.sapClient,
      transport: input.transport,
      outcome: transport ? 'returned' : 'absent_from_response',
      objects: objects.slice(0, limit).map((o) => ({
        ...o,
        suggestedKind:
          o.type === 'BSVS' ? 'status_profile' : o.type === 'TABU' ? 'table' : o.type === 'VDAT' ? 'view' : null,
        capabilities: {
          discoverable: true,
          readable: 'not_checked',
          preparable: 'not_checked',
          verifiable: 'not_checked',
        },
      })),
      truncated: objects.length > limit,
      completeness: 'Only objects supplied by SAP ADT; use read to check individual capabilities.',
    };
  } else {
    switch (input.action) {
      case 'discover':
        result = await workflow.discover(input);
        break;
      case 'read':
        result = await workflow.read(input);
        break;
      case 'prepare':
        result = await workflow.prepare(input);
        break;
      case 'guide':
        result = await workflow.guide(input.changeSetId!);
        break;
      case 'verify':
        try {
          result = await workflow.verify(input.changeSetId!, input.transport!);
        } catch {
          result = {
            changeSetId: input.changeSetId,
            values: { outcome: 'unverifiable' },
            transport: { outcome: 'unverifiable' },
            reason:
              'Snapshot, fresh row, metadata or permissions could not be validated. Read the object again; do not treat this as a successful save.',
          };
        }
        break;
    }
  }
  return textResult(toolJson(result));
}
