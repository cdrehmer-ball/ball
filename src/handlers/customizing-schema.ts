import { z } from 'zod';

const name = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_/]+$/)
  .max(40);
const values = z.record(name, z.string().max(1024)).refine((v) => Object.keys(v).length <= 40);
export const SAPCustomizingSchema = z
  .object({
    action: z.enum(['discover', 'read', 'prepare', 'guide', 'verify']),
    kind: z.enum(['table', 'view', 'status_profile']).optional(),
    name: name.optional(),
    textTable: z.enum(['TJ20T', 'TJ30T']).optional(),
    query: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_/*]+$/)
      .min(2)
      .max(40)
      .optional(),
    transport: name.optional(),
    keys: values.optional(),
    changes: values.optional(),
    changeSetId: z.string().uuid().optional(),
    maxRows: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (['read', 'prepare'].includes(v.action) && (!v.name || !v.kind)) fail('name and kind are required.');
    if (v.action === 'discover' && !v.transport && !v.query && !v.name)
      fail('Supply transport, name or a bounded name query.');
    if (v.action === 'prepare' && (!v.keys || !v.changes || !Object.keys(v.changes).length || !v.transport))
      fail('prepare requires explicit keys, changed fields and intended transport/task.');
    if (['guide', 'verify'].includes(v.action) && !v.changeSetId) fail('changeSetId is required.');
    if (v.action === 'verify' && !v.transport) fail('verify requires the actual transport/task used in SAP GUI.');
  });
export type CustomizingInput = z.infer<typeof SAPCustomizingSchema>;
export const customizingDefinition = {
  name: 'SAPCustomizing',
  description:
    'Local guided customising: read and prepare existing keyed text/row updates; user saves in SAP GUI; verify values and CTS evidence. No SAP writes.',
  inputSchema: z.toJSONSchema(SAPCustomizingSchema, { unrepresentable: 'any' }) as Record<string, unknown>,
  annotations: { readOnlyHint: true },
};
