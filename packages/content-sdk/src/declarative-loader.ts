/**
 * Declarative game module loader.
 *
 * Assembles a full GameModule from JSON/Markdown files in a module directory,
 * without requiring any TypeScript entry point.
 *
 * Activated when manifest.json sets `entry: "declarative"`.
 *
 * File discovery (all optional except manifest.json):
 *   manifest.json       — required, module identity
 *   setting.json        — world config (era, tone, themes, taboos)
 *   lore/*.md           — markdown lore files
 *   classes.json        — character class definitions
 *   dm.md               — DM system prompt (markdown)
 *   dm-config.json      — DM guardrails, tool policy, default actions
 *   initial-state.json  — initial worldState for new campaigns
 *   indicators/*.json   — UI resource indicators
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleManifestSchema } from "@opendungeon/shared";
import type { ModuleManifest } from "@opendungeon/shared";
import type {
  GameModule,
  CharacterTemplate,
  SettingConfig,
  DungeonMasterModuleConfig,
  GameModuleSetting,
  ResourceSchema,
  StateCatalog,
  Mechanic
} from "./index.js";
import {
  loadLoreFilesSync,
  loadResourcesDirSync,
  loadStateCatalogDirSync,
  loadClassesFileSync,
  loadDmConfigFileSync,
  loadInitialStateFileSync
} from "./node-utils.js";

const FALLBACK_CLASS: CharacterTemplate = { level: 1, hp: 100 };
const FALLBACK_CLASS_NAME = "Adventurer";

/**
 * Resolve the base directory for content files.
 * If a `content/` subdirectory exists, content lives there.
 * Otherwise falls back to the module root (legacy layout).
 */
const resolveContentBase = (modulePath: string): string => {
  const contentDir = join(modulePath, "content");
  return existsSync(contentDir) ? contentDir : modulePath;
};

export interface DeclarativeModuleResult {
  gameModule: GameModule;
  /** Non-fatal warnings about missing optional files. */
  warnings: string[];
}

/**
 * Base module data loaded from declarative JSON/Markdown files.
 * This is everything except mechanics (which can come from both
 * declarative files and TypeScript).
 */
export interface DeclarativeModuleBase {
  manifest: ModuleManifest;
  initial: {
    worldState(): Record<string, unknown>;
  };
  characters: {
    getTemplate(className: string): CharacterTemplate;
    availableClasses: string[];
  };
  dm: DungeonMasterModuleConfig;
  setting?: GameModuleSetting;
  resources?: ResourceSchema[];
  state?: StateCatalog;
}

export interface DeclarativeBaseResult {
  base: DeclarativeModuleBase;
  mechanics: Mechanic[];
  warnings: string[];
}

/**
 * Load a GameModule entirely from declarative files in a directory.
 *
 * The returned GameModule has `mechanics: []` — gameplay logic is expected
 * to be provided via TypeScript mechanics from a compiled entry point.
 *
 * @param modulePath Absolute path to the game module directory.
 */
export const loadDeclarativeGameModule = (modulePath: string): DeclarativeModuleResult => {
  const warnings: string[] = [];
  const contentBase = resolveContentBase(modulePath);

  // ── manifest (required) — always at module root ──────────────────────────
  const manifestRaw = JSON.parse(readFileSync(join(modulePath, "manifest.json"), "utf8"));
  const manifest = moduleManifestSchema.parse(manifestRaw);

  // ── setting.json (optional) ──────────────────────────────────────────────
  let settingConfig: SettingConfig | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(contentBase, "setting.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      settingConfig = raw as SettingConfig;
    }
  } catch {
    // file absent or unreadable — fine
  }

  // ── lore/*.md (optional) ─────────────────────────────────────────────────
  const loreFiles = loadLoreFilesSync(join(contentBase, "lore"));

  // ── classes.json (optional) ──────────────────────────────────────────────
  const classData = loadClassesFileSync(join(contentBase, "classes.json"));
  if (!classData) {
    warnings.push(
      `No classes.json found — using single default class "${FALLBACK_CLASS_NAME}". ` +
        `Create classes.json to define character classes.`
    );
  }

  const availableClasses = classData?.classes.map((c) => c.name) ?? [FALLBACK_CLASS_NAME];
  const fallback = classData?.fallback ?? FALLBACK_CLASS;

  const getTemplate = (className: string): CharacterTemplate => {
    const match = classData?.classes.find((c) => c.name === className);
    if (match) {
      return { level: match.level, hp: match.hp, attributes: match.attributes };
    }
    return fallback;
  };

  // ── dm.md + dm-config.json (optional) ────────────────────────────────────
  const dmConfig = loadDmConfigFileSync(join(contentBase, "dm-config.json")) ?? {};

  // ── initial-state.json (optional) ────────────────────────────────────────
  const initialState = loadInitialStateFileSync(join(contentBase, "initial-state.json")) ?? {};

  // ── indicators/*.json (optional) ─────────────────────────────────────────
  const state = loadStateCatalogDirSync(join(contentBase, "state"));
  const resources = loadResourcesDirSync(join(contentBase, "indicators"));
  const stateVarIds = new Set(state.variables.map((v) => v.id));
  const invalidResources = resources.filter((resource) => !stateVarIds.has(resource.varId));
  if (invalidResources.length > 0) {
    throw new Error(
      `Invalid indicator bindings: ${invalidResources.map((r) => `${r.id}->${r.varId}`).join(", ")}. ` +
        `Each indicator varId must reference a variable in content/state/*.json.`
    );
  }

  const gameModule: GameModule = {
    manifest,
    initial: {
      worldState: () => ({ ...initialState })
    },
    characters: {
      availableClasses,
      getTemplate
    },
    dm: dmConfig,
    setting:
      settingConfig || loreFiles.length > 0
        ? { config: settingConfig, loreFiles }
        : undefined,
    mechanics: [],
    resources: resources.length > 0 ? resources : undefined,
    state: state.variables.length > 0 ? state : undefined
  };

  return { gameModule, warnings };
};

/**
 * Load only the declarative base (everything except mechanics).
 * Returns base data and declarative mechanics separately for merging
 * with TypeScript mechanics.
 */
export const loadDeclarativeModuleBase = (modulePath: string): DeclarativeBaseResult => {
  const warnings: string[] = [];
  const contentBase = resolveContentBase(modulePath);

  // ── manifest (required) — always at module root ──────────────────────────
  const manifestRaw = JSON.parse(readFileSync(join(modulePath, "manifest.json"), "utf8"));
  const manifest = moduleManifestSchema.parse(manifestRaw);

  // ── setting.json (optional) ──────────────────────────────────────────────
  let settingConfig: SettingConfig | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(contentBase, "setting.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      settingConfig = raw as SettingConfig;
    }
  } catch {
    // file absent or unreadable — fine
  }

  // ── lore/*.md (optional) ─────────────────────────────────────────────────
  const loreFiles = loadLoreFilesSync(join(contentBase, "lore"));

  // ── classes.json (optional) ──────────────────────────────────────────────
  const classData = loadClassesFileSync(join(contentBase, "classes.json"));
  if (!classData) {
    warnings.push(
      `No classes.json found — using single default class "${FALLBACK_CLASS_NAME}". ` +
        `Create classes.json to define character classes.`
    );
  }

  const availableClasses = classData?.classes.map((c) => c.name) ?? [FALLBACK_CLASS_NAME];
  const fallback = classData?.fallback ?? FALLBACK_CLASS;

  const getTemplate = (className: string): CharacterTemplate => {
    const match = classData?.classes.find((c) => c.name === className);
    if (match) {
      return { level: match.level, hp: match.hp, attributes: match.attributes };
    }
    return fallback;
  };

  // ── dm.md + dm-config.json (optional) ────────────────────────────────────
  const dmConfig = loadDmConfigFileSync(join(contentBase, "dm-config.json")) ?? {};

  // ── initial-state.json (optional) ────────────────────────────────────────
  const initialState = loadInitialStateFileSync(join(contentBase, "initial-state.json")) ?? {};

  // ── indicators/*.json (optional) ─────────────────────────────────────────
  const state = loadStateCatalogDirSync(join(contentBase, "state"));
  const resources = loadResourcesDirSync(join(contentBase, "indicators"));
  const stateVarIds = new Set(state.variables.map((v) => v.id));
  const invalidResources = resources.filter((resource) => !stateVarIds.has(resource.varId));
  if (invalidResources.length > 0) {
    throw new Error(
      `Invalid indicator bindings: ${invalidResources.map((r) => `${r.id}->${r.varId}`).join(", ")}. ` +
        `Each indicator varId must reference a variable in content/state/*.json.`
    );
  }

  const base: DeclarativeModuleBase = {
    manifest,
    initial: {
      worldState: () => ({ ...initialState })
    },
    characters: {
      availableClasses,
      getTemplate
    },
    dm: dmConfig,
    setting:
      settingConfig || loreFiles.length > 0
        ? { config: settingConfig, loreFiles }
        : undefined,
    resources: resources.length > 0 ? resources : undefined,
    state: state.variables.length > 0 ? state : undefined
  };

  const mechanics: Mechanic[] = [];

  return { base, mechanics, warnings };
};
