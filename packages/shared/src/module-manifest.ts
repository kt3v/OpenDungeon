import { z } from "zod";

export const moduleManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  engine: z.string().min(1),
  contentApi: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
  entry: z.string().min(1),
  stateVersion: z.number().int().nonnegative()
});

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
