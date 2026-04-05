/**
 * Node.js utilities for game module development.
 * These functions require a Node.js runtime and are intended for use
 * in game module entry points loaded by the gateway.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SkillSchema } from "./index.js";

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
