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
 *   skills/*.json       — declarative skills
 *   resources/*.json    — UI resource indicators
 *   hooks/*.json        — declarative mechanic hooks (onCharacterCreated, etc.)
 *   rules/*.json        — declarative rules (onActionResolved effects)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleManifestSchema } from "@opendungeon/shared";
import type { ModuleManifest } from "@opendungeon/shared";
import type {
  GameModule,
  CharacterTemplate,
  SettingConfig,
  DungeonMasterModuleConfig,
  GameModuleSetting,
  SkillSchema,
  ResourceSchema,
  Mechanic
} from "./index.js";
import {
  loadSkillsDirSync,
  loadLoreFilesSync,
  loadResourcesDirSync,
  loadClassesFileSync,
  loadDmConfigFileSync,
  loadInitialStateFileSync,
  loadHooksDirSync,
  loadRulesDirSync
} from "./node-utils.js";
import { hookSchemasToMechanics } from "./hook-loader.js";
import { ruleSchemasToMechanics } from "./rule-loader.js";

const FALLBACK_CLASS: CharacterTemplate = { level: 1, hp: 100 };
const FALLBACK_CLASS_NAME = "Adventurer";

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
  skills?: SkillSchema[];
  resources?: ResourceSchema[];
}

export interface DeclarativeBaseResult {
  base: DeclarativeModuleBase;
  mechanics: Mechanic[];
  warnings: string[];
}

/**
 * Load a GameModule entirely from declarative files in a directory.
 *
 * The returned GameModule has `mechanics: []` — TypeScript mechanics require
 * a compiled entry point. Use hooks/*.json for initialisation logic instead.
 *
 * @param modulePath Absolute path to the game module directory.
 */
export const loadDeclarativeGameModule = (modulePath: string): DeclarativeModuleResult => {
  const warnings: string[] = [];

  // ── manifest (required) ─────────────────────────────────────────────────
  const manifestRaw = JSON.parse(readFileSync(join(modulePath, "manifest.json"), "utf8"));
  const manifest = moduleManifestSchema.parse(manifestRaw);

  // ── setting.json (optional) ──────────────────────────────────────────────
  let settingConfig: SettingConfig | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(modulePath, "setting.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      settingConfig = raw as SettingConfig;
    }
  } catch {
    // file absent or unreadable — fine
  }

  // ── lore/*.md (optional) ─────────────────────────────────────────────────
  const loreFiles = loadLoreFilesSync(join(modulePath, "lore"));

  // ── classes.json (optional) ──────────────────────────────────────────────
  const classData = loadClassesFileSync(join(modulePath, "classes.json"));
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
  const dmConfig = loadDmConfigFileSync(join(modulePath, "dm-config.json")) ?? {};

  // ── initial-state.json (optional) ────────────────────────────────────────
  const initialState = loadInitialStateFileSync(join(modulePath, "initial-state.json")) ?? {};

  // ── skills/*.json (optional) ─────────────────────────────────────────────
  const skills = loadSkillsDirSync(join(modulePath, "skills"));

  // ── resources/*.json (optional) ──────────────────────────────────────────
  const resources = loadResourcesDirSync(join(modulePath, "resources"));

  // ── hooks/*.json → Mechanic[] ─────────────────────────────────────────────
  const hookSchemas = loadHooksDirSync(join(modulePath, "hooks"));
  const hookMechanics = hookSchemasToMechanics(hookSchemas);

  // ── rules/*.json → Mechanic[] ─────────────────────────────────────────────
  const ruleSchemas = loadRulesDirSync(join(modulePath, "rules"));
  const ruleMechanics = ruleSchemasToMechanics(ruleSchemas);

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
    mechanics: [...hookMechanics, ...ruleMechanics],
    skills: skills.length > 0 ? skills : undefined,
    resources: resources.length > 0 ? resources : undefined
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

  // ── manifest (required) ─────────────────────────────────────────────────
  const manifestRaw = JSON.parse(readFileSync(join(modulePath, "manifest.json"), "utf8"));
  const manifest = moduleManifestSchema.parse(manifestRaw);

  // ── setting.json (optional) ──────────────────────────────────────────────
  let settingConfig: SettingConfig | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(modulePath, "setting.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      settingConfig = raw as SettingConfig;
    }
  } catch {
    // file absent or unreadable — fine
  }

  // ── lore/*.md (optional) ─────────────────────────────────────────────────
  const loreFiles = loadLoreFilesSync(join(modulePath, "lore"));

  // ── classes.json (optional) ──────────────────────────────────────────────
  const classData = loadClassesFileSync(join(modulePath, "classes.json"));
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
  const dmConfig = loadDmConfigFileSync(join(modulePath, "dm-config.json")) ?? {};

  // ── initial-state.json (optional) ────────────────────────────────────────
  const initialState = loadInitialStateFileSync(join(modulePath, "initial-state.json")) ?? {};

  // ── skills/*.json (optional) ─────────────────────────────────────────────
  const skills = loadSkillsDirSync(join(modulePath, "skills"));

  // ── resources/*.json (optional) ──────────────────────────────────────────
  const resources = loadResourcesDirSync(join(modulePath, "resources"));

  // ── hooks/*.json → Mechanic[] ─────────────────────────────────────────────
  const hookSchemas = loadHooksDirSync(join(modulePath, "hooks"));
  const hookMechanics = hookSchemasToMechanics(hookSchemas);

  // ── rules/*.json → Mechanic[] ─────────────────────────────────────────────
  const ruleSchemas = loadRulesDirSync(join(modulePath, "rules"));
  const ruleMechanics = ruleSchemasToMechanics(ruleSchemas);

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
    skills: skills.length > 0 ? skills : undefined,
    resources: resources.length > 0 ? resources : undefined
  };

  const mechanics = [...hookMechanics, ...ruleMechanics];

  return { base, mechanics, warnings };
};
