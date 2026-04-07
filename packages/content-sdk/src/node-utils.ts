/**
 * Node.js utilities for game module development.
 * These functions require a Node.js runtime and are intended for use
 * in game module entry points loaded by the gateway.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ResourceSchema,
  CharacterTemplate,
  DungeonMasterModuleConfig,
  DungeonMasterContextModule
} from "./index.js";
import {
  classesFileSchema,
  dmConfigFileSchema,
  initialStateFileSchema,
  type CharacterClassEntry
} from "@opendungeon/shared";

const parsePrimitiveFrontmatterValue = (value: string): unknown => {
  const raw = value.trim();
  if (!raw) return "";

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  if (raw === "true") return true;
  if (raw === "false") return false;

  if (/^-?\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => parsePrimitiveFrontmatterValue(item.trim()))
      .filter((item) => typeof item === "string" && item.length > 0);
  }

  return raw;
};

const splitFrontmatter = (raw: string): { frontmatter: string; body: string } => {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: "", body: normalized };
  }

  return {
    frontmatter: match[1] ?? "",
    body: match[2] ?? ""
  };
};

const parseFrontmatterObject = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) return {};

  const output: Record<string, unknown> = {};
  let activeArrayKey: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (activeArrayKey && trimmed.startsWith("- ")) {
      const next = parsePrimitiveFrontmatterValue(trimmed.slice(2).trim());
      if (typeof next === "string" && next.length > 0) {
        (output[activeArrayKey] as string[]).push(next);
      }
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) {
      activeArrayKey = null;
      continue;
    }

    const key = kv[1]!;
    const valueRaw = kv[2] ?? "";
    if (!valueRaw.trim()) {
      output[key] = [];
      activeArrayKey = key;
      continue;
    }

    output[key] = parsePrimitiveFrontmatterValue(valueRaw);
    activeArrayKey = null;
  }

  return output;
};

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

/**
 * Synchronously load all `*.md` context modules from a directory.
 *
 * Supports optional YAML-like frontmatter:
 *
 * ---
 * id: trading
 * priority: 80
 * alwaysInclude: false
 * triggers:
 *   - buy
 *   - sell
 * ---
 *
 * If no frontmatter id is provided, filename (without extension) is used.
 */
export const loadContextModulesDirSync = (dirPath: string): DungeonMasterContextModule[] => {
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: DungeonMasterContextModule[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const fullPath = join(dirPath, file);
    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf8");
    } catch (err) {
      console.warn(`[content-sdk] Failed to read context module "${file}": ${String(err)}`);
      continue;
    }

    const { frontmatter, body } = splitFrontmatter(raw);
    const parsed = parseFrontmatterObject(frontmatter);

    const idFromMeta = typeof parsed.id === "string" ? parsed.id.trim() : "";
    const fallbackId = file.replace(/\.md$/, "");
    const id = idFromMeta || fallbackId;
    const content = body.trim();

    if (!content) {
      console.warn(`[content-sdk] Skipping empty context module "${file}".`);
      continue;
    }

    const module: DungeonMasterContextModule = {
      id,
      content,
      file,
      triggers: toStringArray(parsed.triggers)
    };

    if (typeof parsed.priority === "number") {
      module.priority = parsed.priority;
    }
    if (typeof parsed.alwaysInclude === "boolean") {
      module.alwaysInclude = parsed.alwaysInclude;
    }

    results.push(module);
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
const VALID_RESOURCE_SOURCES = new Set(["characterState", "worldState"]);
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
 *   resources: loadResourcesDirSync(new URL("./indicators", import.meta.url).pathname),
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
  const contextModules = [
    ...loadContextModulesDirSync(join(dirPath, "modules")),
    ...loadContextModulesDirSync(join(dirPath, "contexts"))
  ];

  let jsonConfig: ReturnType<typeof dmConfigFileSchema.parse> | null = null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    jsonConfig = dmConfigFileSchema.parse(parsed);
  } catch (err: unknown) {
    // If file doesn't exist, that's fine — we may still have dm.md
    if (mdPrompt === null && contextModules.length === 0) return null;
    // If file exists but is invalid JSON/schema, throw
    if (err instanceof Error && !("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
      throw err;
    }
  }

  if (!jsonConfig && !mdPrompt && contextModules.length === 0) return null;

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
  const jsonConfigRecord = jsonConfig as Record<string, unknown> | null;
  if (jsonConfigRecord && typeof jsonConfigRecord.contextRouter === "object" && jsonConfigRecord.contextRouter) {
    config.contextRouter = jsonConfigRecord.contextRouter as DungeonMasterModuleConfig["contextRouter"];
  }
  if (contextModules.length > 0) {
    config.contextModules = contextModules;
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
