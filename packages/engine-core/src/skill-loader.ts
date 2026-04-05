import type { Mechanic, SkillSchema, SkillValidation } from "@opendungeon/content-sdk";
import type { SessionEndReason } from "@opendungeon/shared";

/**
 * All declarative skills are bundled into a single synthetic mechanic
 * under this id. Routing keys follow the pattern "skills.<skillId>",
 * e.g. "skills.bargain", "skills.rest".
 *
 * This id is reserved — TypeScript mechanics should not use it.
 */
export const SKILLS_MECHANIC_ID = "skills";

/**
 * Resolve a dot-path against an object, e.g. "inventory.length" → array.length.
 * Returns undefined when any segment of the path is missing.
 */
const resolvePath = (obj: Record<string, unknown>, dotPath: string): unknown => {
  const parts = dotPath.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor && typeof cursor === "object" && part in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
};

/**
 * Evaluate a SkillValidation condition against the current worldState.
 * Numeric operators coerce both sides via Number() before comparing.
 */
const evaluateCondition = (
  worldState: Record<string, unknown>,
  validation: SkillValidation
): boolean => {
  const actual = resolvePath(worldState, validation.worldStateKey);
  const operator = validation.operator ?? "truthy";

  switch (operator) {
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    case "==":
      return actual === validation.value;
    case "!=":
      return actual !== validation.value;
    case ">": {
      const a = Number(actual), b = Number(validation.value);
      return !isNaN(a) && !isNaN(b) && a > b;
    }
    case ">=": {
      const a = Number(actual), b = Number(validation.value);
      return !isNaN(a) && !isNaN(b) && a >= b;
    }
    case "<": {
      const a = Number(actual), b = Number(validation.value);
      return !isNaN(a) && !isNaN(b) && a < b;
    }
    case "<=": {
      const a = Number(actual), b = Number(validation.value);
      return !isNaN(a) && !isNaN(b) && a <= b;
    }
  }
};

/**
 * Interpolate `{{path}}` expressions in a skill's dmPromptExtension template.
 *
 * Supported paths:
 *   {{worldState.key}}          — top-level worldState value
 *   {{worldState.nested.key}}   — nested dot-path access
 *
 * Unknown or undefined paths are left as-is (no silent empty string).
 *
 * @example
 * "Gold: {{worldState.gold}}, HP: {{worldState.player.hp}}"
 * → "Gold: 42, HP: 80"
 */
const interpolate = (
  template: string,
  ctx: { worldState: Record<string, unknown> }
): string => {
  // Wrap worldState so templates use "worldState.*" paths
  const root: Record<string, unknown> = { worldState: ctx.worldState };
  return template.replace(/\{\{([^}]+)\}\}/g, (_, rawPath: string) => {
    const value = resolvePath(root, rawPath.trim());
    return value != null ? String(value) : "";
  });
};

/**
 * Convert an array of SkillSchema definitions into a single Mechanic.
 *
 * - resolve: "ai" skills contribute only dmPromptExtension (no action registered).
 * - resolve: "deterministic" skills register a named action with a fixed outcome.
 *
 * Returns null when the array is empty.
 */
export const skillSchemasToMechanic = (schemas: SkillSchema[]): Mechanic | null => {
  if (schemas.length === 0) return null;

  const actions: NonNullable<Mechanic["actions"]> = {};

  for (const schema of schemas) {
    if (schema.resolve !== "deterministic" || !schema.outcome) continue;

    const outcome = schema.outcome;
    const validation = schema.validate;

    actions[schema.id] = {
      description: schema.description,
      ...(schema.paramSchema ? { paramSchema: schema.paramSchema } : {}),
      ...(validation
        ? {
            validate: (ctx) =>
              evaluateCondition(ctx.worldState, validation) ? true : validation.failMessage
          }
        : {}),
      resolve: async (ctx) => ({
        message: interpolate(outcome.message, { worldState: ctx.worldState }),
        ...(outcome.worldPatch ? { worldPatch: outcome.worldPatch } : {}),
        ...(outcome.characterPatch ? { characterPatch: outcome.characterPatch } : {}),
        ...(outcome.suggestedActions ? { suggestedActions: outcome.suggestedActions } : {}),
        ...(outcome.endSession
          ? { endSession: outcome.endSession as SessionEndReason }
          : {})
      })
    };
  }

  const templates = schemas
    .filter((s) => s.dmPromptExtension)
    .map((s) => s.dmPromptExtension!);

  const hasActions = Object.keys(actions).length > 0;
  const hasTemplates = templates.length > 0;

  if (!hasActions && !hasTemplates) return null;

  return {
    id: SKILLS_MECHANIC_ID,
    ...(hasActions ? { actions } : {}),
    ...(hasTemplates
      ? {
          dmPromptExtension: (ctx) =>
            templates.map((t) => interpolate(t, ctx)).join("\n\n")
        }
      : {})
  };
};
