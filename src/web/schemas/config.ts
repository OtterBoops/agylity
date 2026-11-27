import { z } from 'zod';

const ConfigPatchSchema = z.record(z.string(), z.unknown());

const ConfigSourceSchema = z.enum(['override', 'env', 'default']);

/** Secrets arrive masked: `resolved`/`overrides` hold the mask, `secretsMeta` says whether one is set. */
export const ConfigViewSchema = z.object({
  resolved: ConfigPatchSchema,
  overrides: ConfigPatchSchema,
  sources: z.record(z.string(), ConfigSourceSchema),
  secretsMeta: z.record(z.string(), z.object({ isSet: z.boolean() })),
});

/** Either one `{ key, value }` write, or an envelope of `set` and/or `clear`. */
export const ConfigUpdateRequestSchema = z.union([
  z.object({ key: z.string(), value: z.unknown() }),
  z.object({
    set: ConfigPatchSchema.optional(),
    clear: z.array(z.string()).optional(),
  }),
]);

export const ConfigUpdateResponseSchema = ConfigViewSchema.extend({
  success: z.boolean(),
  cleared: z.array(z.string()),
});

export const ConfigDeleteResponseSchema = ConfigViewSchema.extend({
  success: z.boolean(),
});
