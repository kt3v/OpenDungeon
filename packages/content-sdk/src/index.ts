import type { ModuleManifest, SessionEndReason } from "@opendungeon/shared";

export { loadSkillsDirSync } from "./node-utils.js";

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
  /**
   * Mutations to the canonical campaign world state — visible to ALL players.
   * Use this for shared world facts: items placed in the world, NPCs killed,
   * doors opened, global quest flags, etc.
   */
  worldPatch?: Record<string, unknown>;
  /**
   * Mutations to this character's private state — visible only to this session.
   * Use this for session-local data: sessionLoot, nearExit, personal flags, etc.
   * Never bleeds into the shared world.
   */
  characterPatch?: Record<string, unknown>;
  suggestedActions?: SuggestedAction[];
  summaryPatch?: DungeonMasterSummaryPatch;
  /** When set the engine will run the session-end pipeline after this turn. */
  endSession?: SessionEndReason;
  /**
   * Set by the engine when a mechanic action (TypeScript or declarative skill)
   * handled this turn. False/absent means the DM narrated freely without
   * invoking any mechanic — useful for analytics and unhandled-intent detection.
   */
  handledByMechanic?: boolean;
}

export interface StatePatch {
  worldPatch?: Record<string, unknown>;
  /** Character-local mutations — applied only to this session's characterState. */
  characterPatch?: Record<string, unknown>;
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
  character: CharacterInfo;
  actionText: string;
}

export interface SessionEndContext extends BaseContext {
  reason: SessionEndReason;
}

export interface CharacterCreatedContext {
  tenantId: string;
  campaignId: string;
  playerId: string;
  character: CharacterInfo;
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

  /**
   * Extra text appended to the DM system prompt every turn.
   * Use to inform the DM about mechanic-specific rules and world state fields.
   */
  dmPromptExtension?(ctx: { worldState: Record<string, unknown> }): string;
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
   * Ordered list of TypeScript mechanics. The engine calls hooks in this order.
   * Earlier mechanics take priority for action routing.
   */
  mechanics: Mechanic[];

  /**
   * Declarative skills loaded alongside TypeScript mechanics.
   * Each skill is converted to a Mechanic by the engine at startup —
   * no TypeScript code required for simple gameplay rules.
   * Skills are processed after all TypeScript mechanics.
   */
  skills?: SkillSchema[];
}

/** Type-safe helper — returns the module as-is (identity). */
export const defineGameModule = (module: GameModule): GameModule => module;

// ---------------------------------------------------------------------------
// Skill Schema — declarative mechanics (no TypeScript required)
// ---------------------------------------------------------------------------

/**
 * Comparison operators for skill pre-condition checks.
 * Numeric operators (>, >=, <, <=) coerce both sides to numbers before comparing.
 */
export type SkillValidationOperator =
  | "truthy"  // worldState value is truthy — default when operator is omitted
  | "falsy"   // worldState value is falsy
  | "=="      // strict equality
  | "!="      // strict inequality
  | ">"       // greater than
  | ">="      // greater than or equal
  | "<"       // less than
  | "<=";     // less than or equal

/**
 * Pre-condition check for a deterministic skill.
 * Supports dot-path access (e.g. "inventory.length") and comparison operators.
 *
 * @example
 * { "worldStateKey": "nearExit", "failMessage": "Reach an exit first." }
 * { "worldStateKey": "gold", "operator": ">=", "value": 50, "failMessage": "Need 50 gold." }
 * { "worldStateKey": "inventory.length", "operator": ">", "value": 0, "failMessage": "Empty-handed." }
 */
export interface SkillValidation {
  /**
   * Dot-path to the worldState value to check.
   * Supports nested access: "player.level", "inventory.length", etc.
   */
  worldStateKey: string;
  /**
   * Comparison operator. Defaults to "truthy" when omitted —
   * existing schemas without an operator continue to work unchanged.
   */
  operator?: SkillValidationOperator;
  /** The value to compare against. Required for ==, !=, >, >=, <, <=. */
  value?: unknown;
  /** Returned to the player when the condition is not met. */
  failMessage: string;
}

/** The fixed outcome applied when a deterministic skill is invoked. */
export interface SkillOutcome {
  message: string;
  worldPatch?: Record<string, unknown>;
  characterPatch?: Record<string, unknown>;
  suggestedActions?: SuggestedAction[];
  /** When set, the engine runs the session-end pipeline after this skill. */
  endSession?: SessionEndReason;
}

/**
 * Declarative skill schema — define mechanics as data instead of TypeScript.
 *
 * resolve: "ai"
 *   The DM handles this skill narratively. The skill only contributes
 *   `dmPromptExtension` to the system prompt. No mechanic action is registered.
 *
 * resolve: "deterministic"
 *   The engine applies the fixed `outcome` when invoked. The skill appears
 *   as a callable tool in the DM's available actions list.
 */
export interface SkillSchema {
  /** Unique identifier. For deterministic skills, used as the action routing key. */
  id: string;
  /** Human-readable description shown to the DM when listing available tools. */
  description: string;
  /**
   * Static text appended to the DM system prompt every turn.
   * Use to inform the DM about this skill's rules and context.
   */
  dmPromptExtension?: string;
  /** How this skill is resolved. */
  resolve: "ai" | "deterministic";
  /**
   * JSON Schema for args the DM should pass when invoking this skill.
   * Only relevant for resolve: "deterministic".
   */
  paramSchema?: Record<string, unknown>;
  /**
   * Fixed outcome applied when the skill is invoked.
   * Required for resolve: "deterministic".
   */
  outcome?: SkillOutcome;
  /**
   * Optional pre-condition check.
   * Only evaluated for resolve: "deterministic".
   */
  validate?: SkillValidation;
}

/** Type-safe helper — returns the skill schema as-is (identity). */
export const defineSkill = (schema: SkillSchema): SkillSchema => schema;

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
}

// ---------------------------------------------------------------------------
// DM tool calls (internal engine contract)
// ---------------------------------------------------------------------------

export type DungeonMasterToolName =
  | "update_world_state"
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
  | { tool: "update_world_state"; args: { patch: Record<string, unknown> } }
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
}

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

    if (item.tool === "update_world_state") {
      output.push({
        tool: "update_world_state",
        args: { patch: sanitizeDungeonMasterWorldPatch(args.patch, { guardrails }) }
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
