import type { ModuleManifest, SessionEndReason } from "@opendungeon/shared";

export {
  loadLoreFilesSync,
  loadResourcesDirSync,
  loadStateCatalogDirSync,
  loadContextModulesDirSync,
  loadClassesFileSync,
  loadDmPromptFileSync,
  loadDmConfigFileSync,
  loadInitialStateFileSync
} from "./node-utils.js";
export { loadDeclarativeGameModule, loadDeclarativeModuleBase } from "./declarative-loader.js";
export type { DeclarativeModuleResult, DeclarativeModuleBase, DeclarativeBaseResult } from "./declarative-loader.js";

export type { SessionEndReason } from "@opendungeon/shared";

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

export interface CharacterInfo {
  id: string;
  name: string;
  className: string;
  level: number;
  hp: number;
}

export interface CharacterTemplate {
  level: number;
  hp: number;
  attributes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface PlayerAction {
  /** Free-text action as submitted by the player. */
  text: string;
  /**
   * Optional explicit mechanic routing key, e.g. "extraction.extract".
   * Format: "<mechanicId>.<actionId>". If provided the engine skips the DM
   * and routes directly to the named mechanic action.
   */
  mechanicActionId?: string;
}

export interface ActionResult {
  message: string;
  /** Typed state operations validated against module state definitions. */
  stateOps?: StateOperation[];
  /**
   * Player's current location. Personal state — each player has their own location
   * even in shared campaigns. Updated when the DM moves the player.
   */
  location?: string;
  suggestedActions?: SuggestedAction[];
  summaryPatch?: DungeonMasterSummaryPatch;
  /** When set the engine will run the session-end pipeline after this turn. */
  endSession?: SessionEndReason;
  /**
   * Set by the engine when a mechanic action
   * handled this turn. False/absent means the DM narrated freely without
   * invoking any mechanic — useful for analytics and unhandled-intent detection.
   */
  handledByMechanic?: boolean;
  /**
   * Which LLM provider was used to generate this response.
   * Contains provider name (e.g., "openai", "anthropic", "gateway-openai", "gateway-anthropic")
   * or "primary"/"fallback" when using gateway round-robin.
   */
  llmProviderUsed?: string;
}

export interface StatePatch {
  stateOps?: StateOperation[];
}

export type StateScope = "world" | "character" | "session";
export type StateValueType = "number" | "text" | "boolean" | "list" | "json";

export interface StateVariable {
  id: string;
  scope: StateScope;
  type: StateValueType;
  defaultValue?: unknown;
  writableBy?: Array<"dm" | "mechanic" | "system">;
}

export interface StateCatalog {
  variables: StateVariable[];
}

export type StateOperationType = "set" | "inc" | "dec" | "append" | "remove";

export interface StateOperation {
  op: StateOperationType;
  varId: string;
  value?: unknown;
}

// ---------------------------------------------------------------------------
// Contexts (passed to mechanic hooks)
// ---------------------------------------------------------------------------

export interface BaseContext {
  tenantId: string;
  campaignId: string;
  sessionId: string;
  playerId: string;
  worldState: Record<string, unknown>;
}

export interface ActionContext extends BaseContext {
  /** Unified character state: hp, level, attributes, inventory + ephemeral data */
  characterState: Record<string, unknown>;
  actionText: string;
}

export interface SessionEndContext extends BaseContext {
  /** Final character-local state for the session being ended. */
  characterState: Record<string, unknown>;
  reason: SessionEndReason;
}

export interface CharacterCreatedContext {
  tenantId: string;
  campaignId: string;
  playerId: string;
  /** Character class name (e.g., "Warrior", "Mage") */
  characterClass: string;
  /** Initial character state from template — hooks can modify/extend it */
  characterState: Record<string, unknown>;
  /** Starting location for this character — populated by the engine before hooks run */
  location: string;
  worldState: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mechanic — the extension primitive
// ---------------------------------------------------------------------------

export interface MechanicActionDef {
  /** Short human-readable description shown to the DM / UI. */
  description: string;
  /**
   * JSON Schema describing the parameters the DM should pass when invoking
   * this action via `mechanicCall.args`. Optional — if absent the DM may
   * call this action with no arguments.
   */
  paramSchema?: Record<string, unknown>;
  /**
   * Return `true` if the action is valid in the current context.
   * Return a string describing why it is NOT valid.
   */
  validate?(ctx: ActionContext): true | string;
  resolve(ctx: ActionContext): Promise<ActionResult>;
}

export interface Mechanic {
  /** Unique identifier, e.g. "extraction" or "inventory". */
  id: string;

  hooks?: {
    /**
     * Called once when a character is created for this campaign.
     * Use it to give starting items, initialize per-player state, or
     * apply class-specific world patches before the first session.
     */
    onCharacterCreated?(ctx: CharacterCreatedContext): Promise<StatePatch | void>;
    /** Called when a session starts. Return a patch to apply to world state. */
    onSessionStart?(ctx: BaseContext): Promise<StatePatch | void>;
    /**
     * Called after a session ends.
     * Use this to transfer loot, update persistent state, etc.
     */
    onSessionEnd?(ctx: SessionEndContext): Promise<StatePatch | void>;
    /**
     * Intercept an action before it reaches the DM.
     * Return the (possibly modified) action to continue, or `null` to block it.
     */
    onActionSubmitted?(
      action: PlayerAction,
      ctx: ActionContext
    ): Promise<PlayerAction | null>;
    /**
     * Post-process the result of any action (mechanic or DM).
     * Return the (possibly modified) result.
     */
    onActionResolved?(
      result: ActionResult,
      ctx: ActionContext
    ): Promise<ActionResult>;
  };

  /**
   * Named actions this mechanic adds to the engine.
   * The engine routes to these before calling the DM when:
   *   - `PlayerAction.mechanicActionId` matches "<this.id>.<key>", or
   *   - `PlayerAction.text` exactly matches `<key>` (case-insensitive).
   */
  actions?: Record<string, MechanicActionDef>;
}

/** Type-safe helper — returns the mechanic as-is (identity). */
export const defineMechanic = (mechanic: Mechanic): Mechanic => mechanic;

// ---------------------------------------------------------------------------
// Game Module — the root export of every game
// ---------------------------------------------------------------------------

export interface GameModule {
  manifest: ModuleManifest;

  initial: {
    /** Returns the world state for a brand-new campaign. */
    worldState(): Record<string, unknown>;
  };

  characters: {
    getTemplate(className: string): CharacterTemplate;
    availableClasses: string[];
  };

  /** DM (LLM) configuration: prompts, guardrails, tool policy. */
  dm: DungeonMasterModuleConfig;

  /**
   * Base setting / world bible configuration.
   * Injected into every DM system prompt to establish the world tone,
   * era, themes, and constraints. Supports both structured config and
   * free-form markdown lore files.
   */
  setting?: GameModuleSetting;

  /**
   * Ordered list of TypeScript mechanics. The engine calls hooks in this order.
   * Earlier mechanics take priority for action routing.
   */
  mechanics: Mechanic[];

  /**
   * Declarative resource definitions for UI display.
   * Each resource maps a state key (from character, characterState, or worldState)
   * to a named indicator shown in the game client.
   * Resources are display-only — data is written by mechanics as usual.
   */
  resources?: ResourceSchema[];
  state?: StateCatalog;
}

/** Type-safe helper — returns the module as-is (identity). */
export const defineGameModule = (module: GameModule): GameModule => module;

// ---------------------------------------------------------------------------
// TypeScript Module Extension — for additional mechanics
// ---------------------------------------------------------------------------

/**
 * TypeScript modules export only mechanics to be merged with declarative base.
 * All other data (classes, DM config, setting) comes from JSON/Markdown files.
 *
 * Use `defineMechanics()` helper to export from src/index.ts:
 *
 *   export default defineMechanics({
 *     mechanics: [myLocationMechanic, myCombatMechanic]
 *   });
 */
export interface TypeScriptModuleExtension {
  /** Additional TypeScript mechanics to merge with declarative ones. */
  mechanics: Mechanic[];
}

/** Type-safe helper for TypeScript module exports. */
export const defineMechanics = (ext: TypeScriptModuleExtension): TypeScriptModuleExtension => ext;

// ---------------------------------------------------------------------------
// Resource Schema — declarative UI indicators (no TypeScript required)
// ---------------------------------------------------------------------------

/**
 * Declares a character or world resource that should be displayed as a UI
 * indicator in the game client. Resources are read-only display constructs —
 * the underlying data is written via strict stateOps on declared variables.
 *
 * @example
 * // indicators/hp.json
 * { "id": "hp", "label": "HP", "varId": "hp", "type": "number" }
 *
 * // indicators/inventory.json
 * { "id": "inventory", "label": "Inventory", "varId": "inventory", "type": "list", "defaultValue": [] }
 */
export interface ResourceSchema {
  /** Unique identifier. Used as a React key in the UI. */
  id: string;
  /** Human-readable label shown in the indicator: "HP", "Gold", "Inventory". */
  label: string;
  /** Canonical state variable id this indicator displays. */
  varId: string;
  /** How the UI should format the value. */
  type: "number" | "text" | "list" | "boolean";
  /**
   * Shown when the key does not exist in the source object yet.
   * Prevents blank indicators before onCharacterCreated runs.
   * Defaults to "—" if omitted.
   */
  defaultValue?: string | number | boolean | unknown[];
  /** Optional UI display hint. Defaults to "compact". */
  display?: "compact" | "badge";
}

/** Type-safe helper — returns the resource schema as-is (identity). */
export const defineResource = (schema: ResourceSchema): ResourceSchema => schema;

// ---------------------------------------------------------------------------
// Suggested actions
// ---------------------------------------------------------------------------

export interface SuggestedAction {
  id: string;
  label: string;
  prompt: string;
}

export interface SuggestedActionStrategyInput {
  state: Record<string, unknown>;
  summary?: string;
  lastSuggestedActions?: SuggestedAction[];
}

export type SuggestedActionStrategy = (
  input: SuggestedActionStrategyInput
) => SuggestedAction[];

// ---------------------------------------------------------------------------
// DM configuration
// ---------------------------------------------------------------------------

export interface DungeonMasterPromptContext {
  campaignTitle?: string;
}

export interface DungeonMasterPromptTemplate {
  lines: ReadonlyArray<string>;
}

export interface DungeonMasterToolPolicy {
  allowedTools?: DungeonMasterToolName[];
  requireSummary?: boolean;
  requireSuggestedActions?: boolean;
}

export interface DungeonMasterGuardrails {
  maxToolCalls: number;
  maxSuggestedActions: number;
  maxWorldPatchKeys: number;
  maxWorldPatchJsonChars: number;
  maxSummaryChars: number;
  maxLatestBeatChars: number;
  maxActionIdChars: number;
  maxActionLabelChars: number;
  maxActionPromptChars: number;
}

export interface DungeonMasterModuleConfig {
  systemPrompt?: string;
  promptTemplate?: DungeonMasterPromptTemplate;
  guardrails?: Partial<DungeonMasterGuardrails>;
  toolPolicy?: DungeonMasterToolPolicy;
  defaultSuggestedActions?: SuggestedAction[];
  suggestedActionStrategy?: SuggestedActionStrategy;
  contextModules?: DungeonMasterContextModule[];
  contextRouter?: DungeonMasterContextRouterConfig;
  narratorStyle?: "collaborative" | "balanced" | "strict";
}

export interface DungeonMasterContextModule {
  id: string;
  content: string;
  priority?: number;
  alwaysInclude?: boolean;
  triggers?: string[];
  /**
   * Optional module dependencies by id.
   * Supports plain ids ("trading") or explicit refs ("module:trading").
   */
  dependsOn?: string[];
  /**
   * Optional machine-precise refs used by runtime routing.
   * Supported prefixes: world:, character:, resource:, module:
   */
  references?: string[];
  /**
   * Optional machine-precise refs this module tends to produce.
   * Supported prefixes: world:, character:, resource:, module:
   */
  provides?: string[];
  /**
   * Optional free-form routing tags/conditions for this module.
   */
  when?: string[];
  file?: string;
}

export interface DungeonMasterContextRouterConfig {
  enabled?: boolean;
  contextTokenBudget?: number;
  maxCandidates?: number;
  maxSelectedModules?: number;
}

// ---------------------------------------------------------------------------
// Setting / World Bible
// ---------------------------------------------------------------------------

/**
 * Structured setting configuration for the game world.
 * Defines the base lore, tone, and constraints that apply to all campaigns
 * using this game module.
 */
export interface SettingConfig {
  /** Human-readable name of the setting (e.g., "Shadowrealm", "Forgotten Realms") */
  name?: string;
  /** General description of the world */
  description?: string;
  /** Historical era (e.g., "Medieval", "Victorian", "Cyberpunk 2077") */
  era?: string;
  /** Level of realism: hard (gritty), soft (heroic), or cinematic (larger than life) */
  realismLevel?: "hard" | "soft" | "cinematic";
  /** Core themes of the setting (e.g., ["survival", "exploration", "political intrigue"]) */
  themes?: string[];
  /** Description of the magic system, if any */
  magicSystem?: string;
  /** Things that should NEVER appear in DM responses */
  taboos?: string[];
  /** Tone guidelines (e.g., "grimdark", "hopeful", "whimsical") */
  tone?: string;
  /**
   * Additional arbitrary fields for setting-specific customization.
   * These are injected into the DM prompt as key-value pairs.
   */
  custom?: Record<string, string>;
}

/**
 * A lore file entry loaded from the lore/ directory.
 */
export interface LoreFile {
  /** Filename (e.g., "magic-system.md") */
  file: string;
  /** Optional stable id for routing, defaults to filename without extension */
  id?: string;
  /** Full markdown content */
  content: string;
  priority?: number;
  alwaysInclude?: boolean;
  triggers?: string[];
  dependsOn?: string[];
  references?: string[];
  provides?: string[];
  when?: string[];
}

/**
 * Complete setting definition for a game module.
 * Combines structured SettingConfig with optional markdown lore files.
 */
export interface GameModuleSetting {
  /** Structured setting configuration */
  config?: SettingConfig;
  /** Markdown lore files loaded from the lore/ directory */
  loreFiles?: LoreFile[];
}

// ---------------------------------------------------------------------------
// DM tool calls (internal engine contract)
// ---------------------------------------------------------------------------

export type DungeonMasterToolName =
  | "update_state"
  | "set_summary"
  | "set_suggested_actions";

export interface DungeonMasterToolCall {
  tool: DungeonMasterToolName;
  args: Record<string, unknown>;
}

export interface DungeonMasterSummaryPatch {
  shortSummary: string;
  latestBeat?: string;
}

export type NormalizedDungeonMasterToolCall =
  | { tool: "update_state"; args: { operations: StateOperation[] } }
  | { tool: "set_summary"; args: DungeonMasterSummaryPatch }
  | { tool: "set_suggested_actions"; args: { actions: SuggestedAction[] } };

// ---------------------------------------------------------------------------
// Guardrail defaults & sanitization utilities
// ---------------------------------------------------------------------------

export const DEFAULT_DUNGEON_MASTER_GUARDRAILS: DungeonMasterGuardrails = {
  maxToolCalls: 6,
  maxSuggestedActions: 5,
  maxWorldPatchKeys: 40,
  maxWorldPatchJsonChars: 6000,
  maxSummaryChars: 280,
  maxLatestBeatChars: 280,
  maxActionIdChars: 64,
  maxActionLabelChars: 80,
  maxActionPromptChars: 240
};

export const resolveDungeonMasterGuardrails = (
  guardrails?: Partial<DungeonMasterGuardrails>
): DungeonMasterGuardrails => ({
  ...DEFAULT_DUNGEON_MASTER_GUARDRAILS,
  ...(guardrails ?? {})
});

export interface NormalizeDungeonMasterToolCallOptions {
  guardrails?: Partial<DungeonMasterGuardrails>;
  fallbackSummary?: string;
  toolPolicy?: DungeonMasterToolPolicy;
  stateCatalog?: StateCatalog;
}

const sanitizeStateOperations = (
  input: unknown,
  options: { stateCatalog?: StateCatalog } = {}
): StateOperation[] => {
  if (!Array.isArray(input)) return [];
  const vars = new Map((options.stateCatalog?.variables ?? []).map((v) => [v.id, v]));
  const out: StateOperation[] = [];

  for (const item of input) {
    if (!isRecord(item)) continue;
    const op = typeof item.op === "string" ? item.op : "";
    const varId = typeof item.varId === "string" ? item.varId.trim() : "";
    if (!varId || !vars.has(varId)) continue;
    if (op !== "set" && op !== "inc" && op !== "dec" && op !== "append" && op !== "remove") continue;
    out.push({ op, varId, value: item.value } as StateOperation);
  }

  return out;
};

const DEFAULT_FALLBACK_ACTION: SuggestedAction = {
  id: "continue",
  label: "Continue",
  prompt: "continue cautiously"
};

export const sanitizeDungeonMasterSummaryPatch = (
  input: unknown,
  options: {
    guardrails?: Partial<DungeonMasterGuardrails>;
    fallbackSummary?: string;
  } = {}
): DungeonMasterSummaryPatch | undefined => {
  const guardrails = resolveDungeonMasterGuardrails(options.guardrails);
  const fallbackSummary = clampText(options.fallbackSummary, guardrails.maxSummaryChars);

  if (!isRecord(input)) {
    if (!fallbackSummary) return undefined;
    return { shortSummary: fallbackSummary };
  }

  const shortSummary =
    clampText(input.shortSummary, guardrails.maxSummaryChars) ?? fallbackSummary;
  if (!shortSummary) return undefined;

  const latestBeat = clampText(input.latestBeat, guardrails.maxLatestBeatChars);
  return { shortSummary, latestBeat };
};

export const sanitizeDungeonMasterSuggestedActions = (
  input: unknown,
  options: {
    guardrails?: Partial<DungeonMasterGuardrails>;
    ensureAtLeastOne?: boolean;
    defaultActions?: SuggestedAction[];
  } = {}
): SuggestedAction[] => {
  const guardrails = resolveDungeonMasterGuardrails(options.guardrails);
  const ensureAtLeastOne = options.ensureAtLeastOne ?? false;
  const fallbackActions = sanitizeSuggestedActionList(
    options.defaultActions ?? [],
    guardrails
  );

  const sanitizeOne = (item: unknown): SuggestedAction | null => {
    if (!isRecord(item)) return null;
    const id = clampText(item.id, guardrails.maxActionIdChars) ?? "action";
    const label = clampText(item.label, guardrails.maxActionLabelChars) ?? "Action";
    const prompt = clampText(item.prompt, guardrails.maxActionPromptChars) ?? "look around";
    return { id, label, prompt };
  };

  if (!Array.isArray(input)) {
    if (ensureAtLeastOne) {
      return fallbackActions.length > 0 ? fallbackActions : [DEFAULT_FALLBACK_ACTION];
    }
    return [];
  }

  const output = input
    .map((item) => sanitizeOne(item))
    .filter((item): item is SuggestedAction => Boolean(item))
    .slice(0, guardrails.maxSuggestedActions);

  if (output.length > 0) return output;

  if (ensureAtLeastOne) {
    return fallbackActions.length > 0 ? fallbackActions : [DEFAULT_FALLBACK_ACTION];
  }
  return [];
};

export const sanitizeDungeonMasterWorldPatch = (
  input: unknown,
  options: { guardrails?: Partial<DungeonMasterGuardrails> } = {}
): Record<string, unknown> => {
  const guardrails = resolveDungeonMasterGuardrails(options.guardrails);
  if (!isRecord(input)) return {};

  const trimmedEntries = Object.entries(input).slice(0, guardrails.maxWorldPatchKeys);
  const output: Record<string, unknown> = Object.fromEntries(trimmedEntries);

  while (Object.keys(output).length > 0) {
    try {
      const serialized = JSON.stringify(output);
      if (serialized.length <= guardrails.maxWorldPatchJsonChars) return output;
    } catch {
      return {};
    }
    const lastKey = Object.keys(output).at(-1);
    if (!lastKey) break;
    delete output[lastKey];
  }

  return {};
};

export const normalizeDungeonMasterToolCalls = (
  value: unknown,
  options: NormalizeDungeonMasterToolCallOptions = {}
): NormalizedDungeonMasterToolCall[] => {
  if (!Array.isArray(value)) return [];

  const guardrails = resolveDungeonMasterGuardrails(options.guardrails);
  const output: NormalizedDungeonMasterToolCall[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.tool !== "string") continue;

    if (
      options.toolPolicy?.allowedTools &&
      !options.toolPolicy.allowedTools.includes(item.tool as DungeonMasterToolName)
    ) {
      continue;
    }

    const args = isRecord(item.args) ? item.args : {};

    if (item.tool === "update_state") {
      const operations = sanitizeStateOperations(args.operations, {
        stateCatalog: options.stateCatalog
      });
      if (operations.length === 0) continue;
      output.push({
        tool: "update_state",
        args: { operations }
      });
      continue;
    }

    if (item.tool === "set_summary") {
      const summaryPatch = sanitizeDungeonMasterSummaryPatch(args, {
        guardrails,
        fallbackSummary: options.fallbackSummary
      });
      if (summaryPatch) {
        output.push({ tool: "set_summary", args: summaryPatch });
      }
      continue;
    }

    if (item.tool === "set_suggested_actions") {
      output.push({
        tool: "set_suggested_actions",
        args: {
          actions: sanitizeDungeonMasterSuggestedActions(args.actions, {
            guardrails,
            ensureAtLeastOne: true
          })
        }
      });
    }
  }

  return output.slice(0, guardrails.maxToolCalls);
};

export const renderDungeonMasterPromptTemplate = (
  template: DungeonMasterPromptTemplate,
  context: DungeonMasterPromptContext = {}
): string => {
  const joined = template.lines.join("\n");
  return joined.replace(/{{(\w+)}}/g, (_, key: string) => {
    const value = (context as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  });
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const clampText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength).trim();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeSuggestedActionList = (
  actions: SuggestedAction[],
  guardrails: DungeonMasterGuardrails
): SuggestedAction[] =>
  actions
    .map((action) => ({
      id: clampText(action.id, guardrails.maxActionIdChars) ?? DEFAULT_FALLBACK_ACTION.id,
      label:
        clampText(action.label, guardrails.maxActionLabelChars) ??
        DEFAULT_FALLBACK_ACTION.label,
      prompt:
        clampText(action.prompt, guardrails.maxActionPromptChars) ??
        DEFAULT_FALLBACK_ACTION.prompt
    }))
    .filter((action) => Boolean(action.id && action.label && action.prompt))
    .slice(0, guardrails.maxSuggestedActions);

// ---------------------------------------------------------------------------
// Setting / Lore rendering
// ---------------------------------------------------------------------------

/**
 * Renders a SettingConfig into a formatted string for the DM system prompt.
 * Includes all structured fields plus custom fields.
 */
export const renderSettingConfig = (config: SettingConfig): string => {
  const lines: string[] = ["## Setting"];

  if (config.name) lines.push(`Name: ${config.name}`);
  if (config.description) lines.push(`Description: ${config.description}`);
  if (config.era) lines.push(`Era: ${config.era}`);
  if (config.realismLevel) lines.push(`Realism: ${config.realismLevel}`);
  if (config.tone) lines.push(`Tone: ${config.tone}`);

  if (config.themes && config.themes.length > 0) {
    lines.push(`Themes: ${config.themes.join(", ")}`);
  }

  if (config.magicSystem) {
    lines.push("");
    lines.push("### Magic System");
    lines.push(config.magicSystem);
  }

  if (config.taboos && config.taboos.length > 0) {
    lines.push("");
    lines.push("### Taboos (NEVER include these)");
    for (const taboo of config.taboos) {
      lines.push(`- ${taboo}`);
    }
  }

  if (config.custom) {
    for (const [key, value] of Object.entries(config.custom)) {
      lines.push(`${key}: ${value}`);
    }
  }

  return lines.join("\n");
};

/**
 * Combines SettingConfig with lore files into a single setting prompt section.
 * Returns empty string if no setting is defined.
 */
export const renderGameModuleSetting = (setting?: GameModuleSetting): string => {
  if (!setting) return "";

  const sections: string[] = [];

  if (setting.config) {
    sections.push(renderSettingConfig(setting.config));
  }

  if (setting.loreFiles && setting.loreFiles.length > 0) {
    for (const loreFile of setting.loreFiles) {
      sections.push("");
      sections.push(`## ${loreFile.file.replace(/\.md$/, "").replace(/_/g, " ")}`);
      sections.push(loreFile.content);
    }
  }

  return sections.join("\n");
};
