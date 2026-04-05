/**
 * Node.js utilities for game module development.
 * These functions require a Node.js runtime and are intended for use
 * in game module entry points loaded by the gateway.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SkillSchema, ResourceSchema, CharacterTemplate, DungeonMasterModuleConfig } from "./index.js";
import {
  classesFileSchema,
  dmConfigFileSchema,
  initialStateFileSchema,
  hookSchema,
  ruleSchema,
  type CharacterClassEntry,
  type HookSchema,
  type RuleSchema
} from "@opendungeon/shared";

const isSkillSchema = (value: unknown): value is SkillSchema => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    obj.id.trim().length > 0 &&
    typeof obj.description === "string" &&
    obj.description.trim().length > 0 &&
    (obj.resolve === "ai" || obj.resolve === "deterministic")
  );
};

/**
 * Synchronously load all `*.json` skill files from a directory.
 *
 * Each file may contain a single SkillSchema object or an array of them.
 * Files that fail to parse or have invalid shapes are skipped with a warning.
 * Returns an empty array when the directory does not exist.
 *
 * @example
 * ```typescript
 * // game/index.ts
 * import { defineGameModule, loadSkillsDirSync } from "@opendungeon/content-sdk";
 *
 * export default defineGameModule({
 *   skills: loadSkillsDirSync(new URL("./skills", import.meta.url).pathname),
 *   // ...
 * });
 * ```
 */
export const loadSkillsDirSync = (dirPath: string): SkillSchema[] => {
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: SkillSchema[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const fullPath = join(dirPath, file);
    let raw: unknown;

    try {
      raw = JSON.parse(readFileSync(fullPath, "utf8"));
    } catch (err) {
      console.warn(`[content-sdk] Failed to parse skill file "${file}": ${String(err)}`);
      continue;
    }

    const items = Array.isArray(raw) ? raw : [raw];

    for (const item of items) {
      if (isSkillSchema(item)) {
        results.push(item);
      } else {
        console.warn(
          `[content-sdk] Skipping invalid skill in "${file}" — ` +
            `must have string "id", "description", and resolve: "ai" | "deterministic".`
        );
      }
    }
  }

  return results;
};

/**
 * Synchronously load all lore markdown files from a directory.
 *
 * Reads all `*.md` files from the directory and returns an array of
 * { file, content } objects. Files that fail to read are skipped with a warning.
 * Returns an empty array when the directory does not exist.
 *
 * @example
 * ```typescript
 * // game/index.ts
 * import { defineGameModule, loadLoreFilesSync } from "@opendungeon/content-sdk";
 *
 * export default defineGameModule({
 *   setting: {
 *     loreFiles: loadLoreFilesSync(new URL("./lore", import.meta.url).pathname)
 *   },
 *   // ...
 * });
 * ```
 */
const VALID_RESOURCE_SOURCES = new Set(["character", "characterState", "worldState"]);
const VALID_RESOURCE_TYPES = new Set(["number", "text", "list", "boolean"]);

const isResourceSchema = (value: unknown): value is ResourceSchema => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" && obj.id.trim().length > 0 &&
    typeof obj.label === "string" && obj.label.trim().length > 0 &&
    typeof obj.source === "string" && VALID_RESOURCE_SOURCES.has(obj.source) &&
    typeof obj.stateKey === "string" && obj.stateKey.trim().length > 0 &&
    typeof obj.type === "string" && VALID_RESOURCE_TYPES.has(obj.type)
  );
};

/**
 * Synchronously load all `*.json` resource files from a directory.
 *
 * Each file may contain a single ResourceSchema object or an array of them.
 * Files that fail to parse or have invalid shapes are skipped with a warning.
 * Returns an empty array when the directory does not exist.
 *
 * @example
 * ```typescript
 * // game/index.ts
 * import { defineGameModule, loadResourcesDirSync } from "@opendungeon/content-sdk";
 *
 * export default defineGameModule({
 *   resources: loadResourcesDirSync(new URL("./resources", import.meta.url).pathname),
 *   // ...
 * });
 * ```
 */
export const loadResourcesDirSync = (dirPath: string): ResourceSchema[] => {
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: ResourceSchema[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const fullPath = join(dirPath, file);
    let raw: unknown;

    try {
      raw = JSON.parse(readFileSync(fullPath, "utf8"));
    } catch (err) {
      console.warn(`[content-sdk] Failed to parse resource file "${file}": ${String(err)}`);
      continue;
    }

    const items = Array.isArray(raw) ? raw : [raw];

    for (const item of items) {
      if (isResourceSchema(item)) {
        results.push(item);
      } else {
        console.warn(
          `[content-sdk] Skipping invalid resource in "${file}" — ` +
            `must have string "id", "label", "stateKey", ` +
            `source: "character"|"characterState"|"worldState", ` +
            `and type: "number"|"text"|"list"|"boolean".`
        );
      }
    }
  }

  return results;
};

// ---------------------------------------------------------------------------
// Declarative file loaders (classes.json, dm.md, dm-config.json, initial-state.json, hooks/)
// ---------------------------------------------------------------------------

/**
 * Load character classes from a `classes.json` file.
 *
 * Returns an object with:
 * - `classes` — the full array of class definitions (for `availableClasses`)
 * - `fallback` — the default class template (entry with `isDefault: true`, or first entry)
 *
 * Returns `null` if the file does not exist. Throws on parse/validation errors.
 *
 * @example
 * ```typescript
 * const classData = loadClassesFileSync(new URL("../classes.json", import.meta.url).pathname);
 * export default defineGameModule({
 *   characters: {
 *     availableClasses: classData?.classes.map(c => c.name) ?? ["Adventurer"],
 *     getTemplate: (cls) => classData?.classes.find(c => c.name === cls) ?? classData?.fallback ?? { level: 1, hp: 100 }
 *   },
 *   // ...
 * });
 * ```
 */
export const loadClassesFileSync = (
  filePath: string
): { classes: CharacterClassEntry[]; fallback: CharacterTemplate } | null => {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const parsed = JSON.parse(raw);
  const result = classesFileSchema.parse(parsed);

  const fallback: CharacterTemplate =
    result.classes.find((c) => c.isDefault) ??
    result.classes[0] ??
    { level: 1, hp: 100 };

  return { classes: result.classes, fallback };
};

/**
 * Load the DM system prompt from a `dm.md` markdown file.
 *
 * Returns the file contents as a string, or `null` if the file does not exist.
 *
 * @example
 * ```typescript
 * const prompt = loadDmPromptFileSync(new URL("../dm.md", import.meta.url).pathname);
 * ```
 */
export const loadDmPromptFileSync = (filePath: string): string | null => {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
};

/**
 * Load DM configuration from a `dm-config.json` file.
 *
 * Also merges in a `dm.md` system prompt if a sibling `dm.md` file exists in the
 * same directory — `dm.md` becomes `systemPrompt`. If `systemPrompt` is also
 * defined in the JSON, the JSON field takes precedence.
 *
 * Returns `null` if neither file exists. Throws on parse/validation errors.
 *
 * Note: `suggestedActionStrategy` (a TypeScript function) is not supported in JSON.
 * If needed, create a TypeScript entry file and add the strategy there.
 *
 * @example
 * ```typescript
 * const dmConfig = loadDmConfigFileSync(new URL("../dm-config.json", import.meta.url).pathname);
 * export default defineGameModule({
 *   dm: dmConfig ?? {},
 *   // ...
 * });
 * ```
 */
export const loadDmConfigFileSync = (filePath: string): DungeonMasterModuleConfig | null => {
  // Try loading dm.md from the same directory as the config file
  const dirPath = filePath.replace(/[/\\][^/\\]+$/, "");
  const mdPath = join(dirPath, "dm.md");
  const mdPrompt = loadDmPromptFileSync(mdPath);

  let jsonConfig: ReturnType<typeof dmConfigFileSchema.parse> | null = null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    jsonConfig = dmConfigFileSchema.parse(parsed);
  } catch (err: unknown) {
    // If file doesn't exist, that's fine — we may still have dm.md
    if (mdPrompt === null) return null;
    // If file exists but is invalid JSON/schema, throw
    if (err instanceof Error && !("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
      throw err;
    }
  }

  if (!jsonConfig && !mdPrompt) return null;

  const config: DungeonMasterModuleConfig = {};

  // dm.md provides the system prompt, JSON systemPrompt overrides it
  if (mdPrompt) config.systemPrompt = mdPrompt;
  if (jsonConfig?.systemPrompt) config.systemPrompt = jsonConfig.systemPrompt;
  if (jsonConfig?.promptTemplate) {
    config.promptTemplate = { lines: jsonConfig.promptTemplate.lines };
  }
  if (jsonConfig?.guardrails) config.guardrails = jsonConfig.guardrails;
  if (jsonConfig?.toolPolicy) {
    config.toolPolicy = {
      allowedTools: jsonConfig.toolPolicy.allowedTools as
        import("./index.js").DungeonMasterToolName[] | undefined,
      requireSummary: jsonConfig.toolPolicy.requireSummary,
      requireSuggestedActions: jsonConfig.toolPolicy.requireSuggestedActions
    };
  }
  if (jsonConfig?.defaultSuggestedActions) {
    config.defaultSuggestedActions = jsonConfig.defaultSuggestedActions;
  }

  return config;
};

/**
 * Load the initial world state from an `initial-state.json` file.
 *
 * Returns the parsed key-value object, or `null` if the file does not exist.
 * Throws on parse/validation errors.
 *
 * @example
 * ```typescript
 * const initialState = loadInitialStateFileSync(new URL("../initial-state.json", import.meta.url).pathname);
 * export default defineGameModule({
 *   initial: { worldState: () => initialState ?? {} },
 *   // ...
 * });
 * ```
 */
export const loadInitialStateFileSync = (filePath: string): Record<string, unknown> | null => {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const parsed = JSON.parse(raw);
  return initialStateFileSchema.parse(parsed);
};

/**
 * Synchronously load all `*.json` hook files from a directory.
 *
 * Each file must contain a single HookSchema object.
 * Files that fail to parse or have invalid shapes are skipped with a warning.
 * Returns an empty array when the directory does not exist.
 *
 * @example
 * ```typescript
 * import { hookSchemasToMechanics } from "@opendungeon/engine-core";
 *
 * const hookSchemas = loadHooksDirSync(new URL("../hooks", import.meta.url).pathname);
 * export default defineGameModule({
 *   mechanics: [...hookSchemasToMechanics(hookSchemas), myMechanic],
 *   // ...
 * });
 * ```
 */
export const loadHooksDirSync = (dirPath: string): HookSchema[] => {
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: HookSchema[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const fullPath = join(dirPath, file);
    let raw: unknown;

    try {
      raw = JSON.parse(readFileSync(fullPath, "utf8"));
    } catch (err) {
      console.warn(`[content-sdk] Failed to parse hook file "${file}": ${String(err)}`);
      continue;
    }

    const parsed = hookSchema.safeParse(raw);
    if (parsed.success) {
      results.push(parsed.data);
    } else {
      console.warn(
        `[content-sdk] Skipping invalid hook in "${file}" — ` +
          `must have string "id" and hook: "onCharacterCreated"|"onSessionStart"|"onSessionEnd". ` +
          `Error: ${parsed.error.message}`
      );
    }
  }

  return results;
};

/**
 * Synchronously load all `*.json` rule files from a directory.
 *
 * Each file must contain a single RuleSchema object.
 * Files that fail to parse or have invalid shapes are skipped with a warning.
 * Returns an empty array when the directory does not exist.
 *
 * @example
 * ```typescript
 * import { ruleSchemasToMechanics } from "@opendungeon/content-sdk";
 *
 * const ruleSchemas = loadRulesDirSync(new URL("../rules", import.meta.url).pathname);
 * export default defineGameModule({
 *   mechanics: [...hookSchemasToMechanics(hookSchemas), ...ruleSchemasToMechanics(ruleSchemas)],
 * });
 * ```
 */
export const loadRulesDirSync = (dirPath: string): RuleSchema[] => {
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: RuleSchema[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const fullPath = join(dirPath, file);
    let raw: unknown;

    try {
      raw = JSON.parse(readFileSync(fullPath, "utf8"));
    } catch (err) {
      console.warn(`[content-sdk] Failed to parse rule file "${file}": ${String(err)}`);
      continue;
    }

    const parsed = ruleSchema.safeParse(raw);
    if (parsed.success) {
      results.push(parsed.data);
    } else {
      console.warn(
        `[content-sdk] Skipping invalid rule in "${file}" — ` +
          `must have "id", trigger: "onActionResolved", and at least one effect. ` +
          `Error: ${parsed.error.message}`
      );
    }
  }

  return results;
};

export const loadLoreFilesSync = (dirPath: string): Array<{ file: string; content: string }> => {
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: Array<{ file: string; content: string }> = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const fullPath = join(dirPath, file);
    let content: string;

    try {
      content = readFileSync(fullPath, "utf8");
      results.push({ file, content });
    } catch (err) {
      console.warn(`[content-sdk] Failed to read lore file "${file}": ${String(err)}`);
      continue;
    }
  }

  return results;
};
