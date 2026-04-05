/**
 * Converts declarative HookSchema definitions into Mechanic objects.
 *
 * This allows game developers to express common hook patterns (setting initial
 * state at character creation or session start) as simple JSON files instead
 * of TypeScript mechanics.
 *
 * Complex hook logic (onActionSubmitted, onActionResolved with conditional
 * logic, cross-session accumulation) still requires TypeScript mechanics.
 */

import type { HookSchema } from "@opendungeon/shared";
import type { Mechanic, StatePatch, CharacterCreatedContext, BaseContext, SessionEndContext } from "./index.js";

/**
 * Converts an array of HookSchema definitions into Mechanic objects.
 *
 * Each hook becomes a minimal Mechanic with only the declared hook implemented.
 * Hook mechanics should be placed at the beginning of the `mechanics` array
 * so they run before other mechanics.
 *
 * @example
 * ```typescript
 * import { hookSchemasToMechanics, loadHooksDirSync } from "@opendungeon/content-sdk";
 *
 * const hookSchemas = loadHooksDirSync(new URL("../hooks", import.meta.url).pathname);
 * export default defineGameModule({
 *   mechanics: [...hookSchemasToMechanics(hookSchemas), extractionMechanic],
 * });
 * ```
 */
export const hookSchemasToMechanics = (schemas: HookSchema[]): Mechanic[] => {
  return schemas.map((schema): Mechanic => {
    switch (schema.hook) {
      case "onCharacterCreated":
        return {
          id: `hook:${schema.id}`,
          hooks: {
            onCharacterCreated: async (ctx: CharacterCreatedContext): Promise<StatePatch | void> => {
              // Start with the root-level patches
              const patch: StatePatch = {
                worldPatch: schema.worldPatch ? { ...schema.worldPatch } : undefined,
                characterPatch: schema.characterPatch ? { ...schema.characterPatch } : undefined
              };

              // Apply class-specific overrides if classBranches is defined
              if (schema.classBranches) {
                const branch = schema.classBranches[ctx.character.className];
                if (branch) {
                  if (branch.worldPatch) {
                    patch.worldPatch = { ...(patch.worldPatch ?? {}), ...branch.worldPatch };
                  }
                  if (branch.characterPatch) {
                    patch.characterPatch = {
                      ...(patch.characterPatch ?? {}),
                      ...branch.characterPatch
                    };
                  }
                }
              }

              // Return undefined if there's nothing to patch
              if (!patch.worldPatch && !patch.characterPatch) return;
              return patch;
            }
          }
        };

      case "onSessionStart":
        return {
          id: `hook:${schema.id}`,
          hooks: {
            onSessionStart: async (_ctx: BaseContext): Promise<StatePatch | void> => {
              const patch: StatePatch = {
                worldPatch: schema.worldPatch ? { ...schema.worldPatch } : undefined,
                characterPatch: schema.characterPatch ? { ...schema.characterPatch } : undefined
              };
              if (!patch.worldPatch && !patch.characterPatch) return;
              return patch;
            }
          }
        };

      case "onSessionEnd":
        return {
          id: `hook:${schema.id}`,
          hooks: {
            onSessionEnd: async (ctx: SessionEndContext): Promise<StatePatch | void> => {
              // If a specific reason is required, only fire for that reason
              if (schema.reason && ctx.reason !== schema.reason) return;

              const patch: StatePatch = {
                worldPatch: schema.worldPatch ? { ...schema.worldPatch } : undefined,
                characterPatch: schema.characterPatch ? { ...schema.characterPatch } : undefined
              };
              if (!patch.worldPatch && !patch.characterPatch) return;
              return patch;
            }
          }
        };
    }
  });
};
