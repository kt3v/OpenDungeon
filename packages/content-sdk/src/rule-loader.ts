/**
 * Converts declarative RuleSchema definitions into Mechanic objects.
 *
 * Rules fire on `onActionResolved` and apply effects (increment, decrement,
 * set, append, remove, endSession) when an optional condition is met.
 *
 * Target path prefixes determine which state store is written to:
 *   "characterState.<key>" → characterState (session-local, private)
 *   "worldState.<key>"     → worldPatch     (shared campaign state)
 *
 * Condition keys read from the merged worldState context (characterState
 * is merged into worldState before hooks run, so "characterState.hp" is
 * readable as ctx.worldState.hp — but written back to characterState).
 */

import type { RuleSchema, RuleCondition, RuleEffect } from "@opendungeon/shared";
import type { Mechanic, ActionResult, ActionContext } from "./index.js";

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/** Resolve a dot-path string against an object. Returns undefined for missing paths. */
const resolvePath = (obj: Record<string, unknown>, dotPath: string): unknown => {
  return dotPath.split(".").reduce<unknown>((curr, key) => {
    if (curr !== null && typeof curr === "object" && !Array.isArray(curr)) {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
};

const evaluateCondition = (
  condition: RuleCondition,
  worldState: Record<string, unknown>
): boolean => {
  const actual = resolvePath(worldState, condition.key);
  const op = condition.operator ?? "truthy";

  switch (op) {
    case "truthy":  return Boolean(actual);
    case "falsy":   return !actual;
    case "==":      return actual === condition.value;
    case "!=":      return actual !== condition.value;
    case ">":       return Number(actual) > Number(condition.value);
    case ">=":      return Number(actual) >= Number(condition.value);
    case "<":       return Number(actual) < Number(condition.value);
    case "<=":      return Number(actual) <= Number(condition.value);
  }
};

// ---------------------------------------------------------------------------
// Effect application
// ---------------------------------------------------------------------------

type PatchPair = {
  worldPatch: Record<string, unknown>;
  characterState: Record<string, unknown>;
};

const applyEffect = (effect: RuleEffect, patches: PatchPair): string | undefined => {
  if (effect.op === "endSession") {
    // endSession is handled by the caller
    return effect.reason;
  }

  const { target } = effect;
  let storeKey: string;
  let isCharacter: boolean;

  if (target.startsWith("characterState.")) {
    storeKey = target.slice("characterState.".length);
    isCharacter = true;
  } else if (target.startsWith("worldState.")) {
    storeKey = target.slice("worldState.".length);
    isCharacter = false;
  } else {
    console.warn(`[rule-loader] Invalid target "${target}" — must start with "characterState." or "worldState."`);
    return undefined;
  }

  const patch = isCharacter ? patches.characterState : patches.worldPatch;

  switch (effect.op) {
    case "increment": {
      const current = Number(patch[storeKey] ?? 0);
      const next = current + effect.amount;
      patch[storeKey] = effect.max !== undefined ? Math.min(next, effect.max) : next;
      break;
    }
    case "decrement": {
      const current = Number(patch[storeKey] ?? 0);
      const minVal = effect.min ?? 0;
      patch[storeKey] = Math.max(current - effect.amount, minVal);
      break;
    }
    case "set": {
      patch[storeKey] = effect.value;
      break;
    }
    case "append": {
      const arr = patch[storeKey];
      patch[storeKey] = Array.isArray(arr) ? [...arr, effect.value] : [effect.value];
      break;
    }
    case "remove": {
      const arr = patch[storeKey];
      if (!Array.isArray(arr)) break;
      if (effect.id !== undefined) {
        patch[storeKey] = arr.filter(
          (item) => !(item !== null && typeof item === "object" && (item as Record<string, unknown>).id === effect.id)
        );
      } else {
        patch[storeKey] = arr.filter((item) => item !== effect.value);
      }
      break;
    }
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts an array of RuleSchema definitions into Mechanic objects.
 *
 * Each rule becomes a minimal Mechanic with only `onActionResolved` implemented.
 * Place rule mechanics AFTER other mechanics so they post-process the final result.
 *
 * @example
 * ```typescript
 * import { ruleSchemasToMechanics, loadRulesDirSync } from "@opendungeon/content-sdk";
 *
 * const ruleSchemas = loadRulesDirSync(new URL("../rules", import.meta.url).pathname);
 * export default defineGameModule({
 *   mechanics: [...hookSchemasToMechanics(hookSchemas), ...ruleSchemasToMechanics(ruleSchemas)],
 * });
 * ```
 */
export const ruleSchemasToMechanics = (schemas: RuleSchema[]): Mechanic[] => {
  return schemas.map((schema): Mechanic => ({
    id: `rule:${schema.id}`,
    hooks: {
      onActionResolved: async (result: ActionResult, ctx: ActionContext): Promise<ActionResult> => {
        // Evaluate condition (if any) against merged worldState
        if (schema.condition && !evaluateCondition(schema.condition, ctx.worldState)) {
          return result;
        }

        // Build mutable patch copies seeded from existing result patches
        const patches: PatchPair = {
          worldPatch: { ...(result.worldPatch ?? {}) },
          characterState: { ...(result.characterState ?? {}) }
        };

        let endSessionReason: string | undefined;

        for (const effect of schema.effects) {
          const reason = applyEffect(effect, patches);
          if (reason !== undefined) {
            endSessionReason = reason;
          }
        }

        return {
          ...result,
          worldPatch: Object.keys(patches.worldPatch).length > 0 ? patches.worldPatch : result.worldPatch,
          characterState: Object.keys(patches.characterState).length > 0 ? patches.characterState : result.characterState,
          ...(endSessionReason !== undefined
            ? { endSession: endSessionReason as import("@opendungeon/shared").SessionEndReason }
            : {})
        };
      }
    }
  }));
};
