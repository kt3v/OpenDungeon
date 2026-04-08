import type {
  ActionContext,
  ActionResult,
  BaseContext,
  CharacterCreatedContext,
  CharacterInfo,
  CharacterTemplate,
  GameModule,
  GameModuleSetting,
  Mechanic,
  PlayerAction,
  SessionEndContext,
  StatePatch,
  SuggestedAction
} from "@opendungeon/content-sdk";
import { renderDungeonMasterPromptTemplate, renderGameModuleSetting } from "@opendungeon/content-sdk";
import type { SessionEndReason } from "@opendungeon/shared";
import { moduleManifestSchema } from "@opendungeon/shared";
import { createProviderFromEnv, type LlmProvider } from "@opendungeon/providers-llm";
import { DungeonMasterRuntime } from "./dungeon-master.js";
import { ContextRouterRuntime, type RouterConfig, type RouterContextModule } from "./context-router.js";
import { ArchivistRuntime } from "./archivist.js";
import type { ArchivistTurnResult } from "./archivist.js";
export { DungeonMasterRuntime } from "./dungeon-master.js";
export { ArchivistRuntime } from "./archivist.js";
export type { ArchivistTurnInput, ArchivistTurnResult } from "./archivist.js";

export { extractLore, type LoreEntryPayload } from "./lore-extractor.js";
export { compressSessionHistory } from "./event-compressor.js";

// ---------------------------------------------------------------------------
// Public input/output types
// ---------------------------------------------------------------------------

export interface RecentEvent {
  createdAt: string;
  playerId: string;
  actionText: string;
  message: string;
}

export interface ExecuteTurnInput {
  tenantId: string;
  campaignId: string;
  sessionId: string;
  playerId: string;
  /** Unified character state: hp, level, attributes, inventory + ephemeral data */
  characterState: Record<string, unknown>;
  /** Player's current location - personal state, not shared across campaign */
  location: string;
  actionText: string;
  /**
   * Explicit mechanic routing key: "<mechanicId>.<actionId>".
   * When provided the engine skips the DM and routes to the mechanic directly.
   */
  mechanicActionId?: string;
  worldState: Record<string, unknown>;
  recentEvents: RecentEvent[];
  campaignTitle?: string;
  summary?: string;
  contextualLore?: string;
  lastSuggestedActions?: SuggestedAction[];
  /**
   * Player's preferred language for DM responses.
   * If empty, DM will respond in the same language as the player's input.
   */
  playerLanguage?: string;
  trace?: {
    recordPhase?: (phase: string, durationMs: number) => void;
    setMeta?: (key: string, value: unknown) => void;
  };
}

export interface CharacterCreatedInput {
  tenantId: string;
  campaignId: string;
  playerId: string;
  characterClass: string;
  characterState: Record<string, unknown>;
  /** Starting location for this character */
  location: string;
  worldState: Record<string, unknown>;
}

export interface StartSessionInput {
  tenantId: string;
  campaignId: string;
  sessionId: string;
  playerId: string;
  characterState: Record<string, unknown>;
  worldState: Record<string, unknown>;
}

export interface EndSessionInput {
  tenantId: string;
  campaignId: string;
  sessionId: string;
  playerId: string;
  reason: SessionEndReason;
  worldState: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EngineRuntime
// ---------------------------------------------------------------------------

export interface EngineRuntimeOptions {
  provider?: LlmProvider;
  routerProvider?: LlmProvider;
  /**
   * Whether to enable the Archivist runtime which normalizes world state
   * and summaries after each turn. When disabled, only DM result is used.
   * Archivist adds an extra LLM call which increases response time.
   * Set via ENABLE_ARCHIVIST=false env var or pass false here.
   * @default true
   */
  enableArchivist?: boolean;
}

export class EngineRuntime {
  private readonly gameModule: GameModule;
  private readonly dmRuntime: DungeonMasterRuntime;
  private readonly contextRouterRuntime: ContextRouterRuntime;
  private readonly archivistRuntime: ArchivistRuntime | undefined;
  private readonly enableArchivist: boolean;
  /** Effective mechanics list: TypeScript mechanics only. */
  private readonly mechanics: Mechanic[];

  constructor(gameModule: GameModule, options: EngineRuntimeOptions = {}) {
    moduleManifestSchema.parse(gameModule.manifest);
    this.gameModule = gameModule;
    this.mechanics = gameModule.mechanics;

    const provider = options.provider ?? createProviderFromEnv();
    const routerProvider = options.routerProvider ?? provider;
    this.dmRuntime = new DungeonMasterRuntime({
      provider,
      moduleConfig: gameModule.dm
    });
    this.contextRouterRuntime = new ContextRouterRuntime(routerProvider);

    // Check both options and env var for archivist (default: true)
    const envEnableArchivist = process.env.ENABLE_ARCHIVIST;
    const envDisabled = envEnableArchivist === "false" || envEnableArchivist === "0";
    this.enableArchivist = options.enableArchivist !== false && !envDisabled;

    if (this.enableArchivist) {
      this.archivistRuntime = new ArchivistRuntime(provider);
    }
  }

  // -------------------------------------------------------------------------
  // Character lifecycle
  // -------------------------------------------------------------------------

  async onCharacterCreated(input: CharacterCreatedInput): Promise<StatePatch> {
    const ctx: CharacterCreatedContext = {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      playerId: input.playerId,
      characterClass: input.characterClass,
      characterState: input.characterState,
      location: input.location,
      worldState: input.worldState
    };

    let worldPatch: Record<string, unknown> = {};
    let characterStatePatch: Record<string, unknown> = {};
    let locationPatch: string | undefined = input.location;

    for (const mechanic of this.mechanics) {
      const fn = mechanic.hooks?.onCharacterCreated;
      if (!fn) continue;
      const patch = await fn(ctx);
      if (patch?.worldPatch) {
        worldPatch = { ...worldPatch, ...patch.worldPatch };
        ctx.worldState = { ...ctx.worldState, ...patch.worldPatch };
      }
      if (patch?.characterState) {
        characterStatePatch = { ...characterStatePatch, ...patch.characterState };
      }
      if (patch?.location) {
        locationPatch = patch.location;
        ctx.location = patch.location;
      }
    }

    const result: StatePatch = {
      worldPatch: Object.keys(worldPatch).length > 0 ? worldPatch : undefined,
      characterState: Object.keys(characterStatePatch).length > 0 ? characterStatePatch : undefined
    };
    if (locationPatch !== input.location) {
      result.location = locationPatch;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async startSession(input: StartSessionInput): Promise<StatePatch> {
    const ctx: BaseContext & { characterState: Record<string, unknown> } = {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      playerId: input.playerId,
      characterState: input.characterState,
      worldState: input.worldState
    };

    return this.runSessionHooks("onSessionStart", ctx);
  }

  async endSession(input: EndSessionInput): Promise<StatePatch> {
    const ctx: SessionEndContext = {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      playerId: input.playerId,
      reason: input.reason,
      worldState: input.worldState
    };

    return this.runSessionEndHooks(ctx);
  }

  // -------------------------------------------------------------------------
  // Main turn pipeline
  // -------------------------------------------------------------------------

  async executeTurn(input: ExecuteTurnInput): Promise<ActionResult> {
    let action: PlayerAction = {
      text: input.actionText,
      mechanicActionId: input.mechanicActionId
    };

    const ctx: ActionContext = {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      playerId: input.playerId,
      worldState: input.worldState,
      characterState: input.characterState,
      actionText: input.actionText
    };

    // 1. Run onActionSubmitted hooks (any mechanic can modify or block)
    for (const mechanic of this.mechanics) {
      if (!mechanic.hooks?.onActionSubmitted) continue;
      const next = await mechanic.hooks.onActionSubmitted(action, ctx);
      if (next === null) {
        // Action blocked by mechanic
        return { message: "Your action was blocked." };
      }
      action = next;
    }

    // 2. Route: mechanic action or DM
    let result: ActionResult;

    const mechanicAction = this.resolveMechanicAction(action, ctx);
    if (mechanicAction) {
      input.trace?.setMeta?.("engine.usedMechanicDirectly", true);
      result = await mechanicAction();
    } else {
      input.trace?.setMeta?.("engine.usedMechanicDirectly", false);
      result = await this.runDm(input, ctx);
    }

    // 3. Run onActionResolved hooks
    for (const mechanic of this.mechanics) {
      if (!mechanic.hooks?.onActionResolved) continue;
      result = await mechanic.hooks.onActionResolved(result, ctx);
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Convenience accessors
  // -------------------------------------------------------------------------

  getManifest() {
    return this.gameModule.manifest;
  }

  getInitialWorldState(): Record<string, unknown> {
    return this.gameModule.initial.worldState();
  }

  getCharacterTemplate(className: string): CharacterTemplate {
    return this.gameModule.characters.getTemplate(className);
  }

  getAvailableClasses(): string[] {
    return this.gameModule.characters.availableClasses;
  }

  getSuggestedActions(input: { worldState: Record<string, unknown> }): SuggestedAction[] {
    const { dm } = this.gameModule;
    if (dm.suggestedActionStrategy) {
      return dm.suggestedActionStrategy({ state: input.worldState });
    }
    return dm.defaultSuggestedActions ?? [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Route an explicit mechanic action from a client-submitted mechanicActionId
   * (e.g. a UI button press). Returns null when no explicit id was provided —
   * in that case the DM decides which mechanic (if any) to invoke.
   */
  private resolveMechanicAction(
    action: PlayerAction,
    ctx: ActionContext
  ): (() => Promise<ActionResult>) | null {
    if (action.mechanicActionId) {
      return this.findMechanicActionById(action.mechanicActionId, ctx);
    }
    return null;
  }

  /**
   * Resolve a mechanic action by its full routing id (e.g. "extraction.extract").
   * Returns a zero-arg executor or null if the id is unknown.
   */
  private findMechanicActionById(
    mechanicActionId: string,
    ctx: ActionContext
  ): (() => Promise<ActionResult>) | null {
    const [mechanicId, actionId] = mechanicActionId.split(".");
    const mechanic = this.mechanics.find((m) => m.id === mechanicId);
    const actionDef = mechanic?.actions?.[actionId ?? ""];
    if (mechanic && actionDef) {
      return () => this.runMechanicAction(mechanic, actionId!, actionDef, ctx);
    }
    return null;
  }

  private async runMechanicAction(
    mechanic: Mechanic,
    actionId: string,
    actionDef: NonNullable<Mechanic["actions"]>[string],
    ctx: ActionContext
  ): Promise<ActionResult> {
    if (actionDef.validate) {
      const valid = actionDef.validate(ctx);
      if (valid !== true) {
        return { message: valid };
      }
    }
    const result = await actionDef.resolve(ctx);
    return { ...result, handledByMechanic: true };
  }

  private async runDm(
    input: ExecuteTurnInput,
    ctx: ActionContext
  ): Promise<ActionResult> {
    const promptStartedAt = Date.now();
    const systemPrompt = await this.buildSystemPrompt(
      ctx.worldState,
      input.actionText,
      input.campaignTitle,
      input.playerLanguage,
      input.trace
    );
    input.trace?.recordPhase?.("engine.buildSystemPrompt", Date.now() - promptStartedAt);

    const availableMechanicActions = this.mechanics.flatMap((m) =>
      Object.entries(m.actions ?? {}).map(([actionId, actionDef]) => ({
        id: `${m.id}.${actionId}`,
        description: actionDef.description,
        ...(actionDef.paramSchema ? { paramSchema: actionDef.paramSchema } : {})
      }))
    );

    try {
      const dmStartedAt = Date.now();
      const dmResult = await this.dmRuntime.runTurn({
        campaignId: input.campaignId,
        sessionId: input.sessionId,
        campaignTitle: input.campaignTitle ?? "",
        playerId: input.playerId,
        actionText: input.actionText,
        worldState: input.worldState,
        location: input.location,
        recentEvents: input.recentEvents,
        summary: input.summary,
        contextualLore: input.contextualLore,
        lastSuggestedActions: input.lastSuggestedActions,
        availableMechanicActions: availableMechanicActions.length > 0
          ? availableMechanicActions
          : undefined,
        trace: input.trace,
        moduleConfig: {
          ...this.gameModule.dm,
          systemPrompt
        }
      });
      input.trace?.recordPhase?.("engine.dm.total", Date.now() - dmStartedAt);
      input.trace?.setMeta?.("dm.provider", dmResult.llmProviderUsed ?? "unknown");

      // If DM chose to delegate to a mechanic, route there deterministically
      if (dmResult.mechanicCall) {
        input.trace?.setMeta?.("engine.dmMechanicCall", dmResult.mechanicCall.id);
        const routed = this.findMechanicActionById(dmResult.mechanicCall.id, ctx);
        if (routed) return routed(); // runMechanicAction sets handledByMechanic: true
        // Unknown mechanic id — fall through to DM narrative
      }

      const dmNarrativeResult: ActionResult = {
        message: dmResult.message,
        worldPatch: dmResult.worldPatch,
        location: dmResult.location,
        summaryPatch: dmResult.summaryPatch,
        suggestedActions: dmResult.suggestedActions,
        llmProviderUsed: dmResult.llmProviderUsed
      };

      // Skip archivist if disabled
      if (!this.enableArchivist || !this.archivistRuntime) {
        input.trace?.setMeta?.("archivist.enabled", false);
        return dmNarrativeResult;
      }

      input.trace?.setMeta?.("archivist.enabled", true);

      // Run archivist fully in background so it never blocks the player turn.
      void this.archivistRuntime.runTurn({
        actionText: input.actionText,
        worldState: input.worldState,
        dmResult: dmNarrativeResult
      }).catch((error) => {
        console.warn("[EngineRuntime] Archivist background run failed:", error);
      });

      input.trace?.setMeta?.("archivist.mode", "background");
      input.trace?.setMeta?.("archivist.deferred", true);
      return dmNarrativeResult;
    } catch {
      // Graceful fallback if DM fails
      return {
        message: `${input.actionText} — the dungeon holds its breath.`,
        suggestedActions: this.getSuggestedActions({ worldState: input.worldState })
      };
    }
  }

  /**
   * Build the final DM system prompt by combining:
   * 1. Setting / world bible (if defined)
   * 2. Module base prompt (promptTemplate or systemPrompt)
   * 3. Routed markdown context modules
   * 4. Active machine references extracted from routed modules
   * 5. Player language preference instruction
   */
  private async buildSystemPrompt(
    worldState: Record<string, unknown>,
    actionText: string,
    campaignTitle?: string,
    playerLanguage?: string,
    trace?: ExecuteTurnInput["trace"]
  ): Promise<string> {
    const { dm, setting } = this.gameModule;
    const routerEnabled = this.isContextRouterEnabled();

    // Section 1: Setting / World Bible
    const settingSection = renderGameModuleSetting(
      routerEnabled && setting?.loreFiles?.length
        ? ({ config: setting.config } satisfies GameModuleSetting)
        : setting
    );

    // Section 2: Base system prompt
    let base: string;
    if (dm.promptTemplate) {
      base = renderDungeonMasterPromptTemplate(dm.promptTemplate, { campaignTitle });
    } else if (dm.systemPrompt) {
      base = dm.systemPrompt;
    } else {
      base = [
        "You are the Dungeon Master for OpenDungeon.",
        "Return strict JSON only with a non-empty message field.",
        "Do not include markdown code fences or commentary."
      ].join("\n");
    }

    // Section 2.5: Narrator style guidelines
    const narratorSection = this.buildNarratorSection(dm.narratorStyle);

    // Section 3: Context modules routed per turn
    const routedModules = await this.resolveRoutedContextModules({
      actionText,
      worldState,
      trace,
      setting
    });
    const modulesSection = routedModules.length > 0
      ? [
          "## Active Context Modules",
          ...routedModules.map((module) => `### ${module.id}\n${module.content}`)
        ].join("\n\n")
      : "";

    // Section 4: Machine references from active modules
    const activeReferencesSection = this.buildActiveReferencesSection(routedModules);

    // Section 5: Language instruction
    let languageSection = "";
    if (playerLanguage) {
      languageSection = `\n\n## Language\nYou MUST respond in ${playerLanguage} language. This is the player's preferred language, regardless of what language they used in their action.`;
    } else {
      languageSection = "\n\n## Language\nRespond in the same language the player used for their action. If the player switches languages, switch with them.";
    }

    // Combine all sections
    const parts: string[] = [];
    if (settingSection) parts.push(settingSection);
    parts.push(base + languageSection);
    if (narratorSection) parts.push(narratorSection);
    if (modulesSection) parts.push(modulesSection);
    if (activeReferencesSection) parts.push(activeReferencesSection);

    trace?.setMeta?.("prompt.settingSectionChars", settingSection.length);
    trace?.setMeta?.("prompt.modulesSectionChars", modulesSection.length);
    trace?.setMeta?.("prompt.activeReferencesChars", activeReferencesSection.length);
    trace?.setMeta?.("prompt.narratorSectionChars", narratorSection.length);
    trace?.setMeta?.("prompt.fullSystemPromptChars", parts.join("\n\n").length);

    return parts.join("\n\n");
  }

  private async resolveRoutedContextModules(input: {
    actionText: string;
    worldState: Record<string, unknown>;
    trace?: ExecuteTurnInput["trace"];
    setting?: GameModuleSetting;
  }): Promise<RouterContextModule[]> {
    const modules = [
      ...this.getConfiguredContextModules(),
      ...this.getLoreRouterModules(input.setting)
    ];
    if (modules.length === 0) return [];
    if (!this.isContextRouterEnabled()) return [];

    const startedAt = Date.now();
    const selection = await this.contextRouterRuntime.selectModules({
      actionText: input.actionText,
      worldState: input.worldState,
      modules,
      config: this.getContextRouterConfig()
    });

    input.trace?.recordPhase?.("engine.contextRouter.total", Date.now() - startedAt);
    input.trace?.setMeta?.("router.enabled", true);
    input.trace?.setMeta?.("router.forceLlmSelection", this.getContextRouterConfig()?.forceLlmSelection ?? false);
    input.trace?.setMeta?.("router.availableModules", modules.length);
    input.trace?.setMeta?.("router.baselineIds", selection.diagnostics.baselineIds);
    input.trace?.setMeta?.("router.baselineApproxTokens", selection.diagnostics.baselineApproxTokens);
    input.trace?.setMeta?.("router.prefCandidateIds", selection.diagnostics.prefCandidateIds);
    input.trace?.setMeta?.("router.prefCandidateCount", selection.diagnostics.prefCandidateIds.length);
    input.trace?.setMeta?.("router.heuristicSelectedIds", selection.diagnostics.heuristicSelectedIds ?? []);
    input.trace?.setMeta?.("router.heuristicSelectedCount", selection.diagnostics.heuristicSelectedIds?.length ?? 0);
    input.trace?.setMeta?.("router.llmSelectedIds", selection.diagnostics.llmSelectedIds);
    input.trace?.setMeta?.("router.llmSelectedCount", selection.diagnostics.llmSelectedIds.length);
    input.trace?.setMeta?.("router.skippedLlmReason", selection.diagnostics.skippedLlmReason ?? null);
    input.trace?.setMeta?.("router.selectedCount", selection.selectedModules.length);
    input.trace?.setMeta?.("router.selectedIds", selection.selectedIds);
    input.trace?.setMeta?.(
      "router.selectedApproxTokens",
      selection.selectedModules.reduce((sum, module) => sum + Math.ceil(module.content.length / 4), 0)
    );

    return selection.selectedModules;
  }

  private getLoreRouterModules(setting?: GameModuleSetting): RouterContextModule[] {
    const loreFiles = setting?.loreFiles ?? [];
    return loreFiles.map((loreFile, index) => {
      const metadata = loreFile as typeof loreFile & {
        id?: string;
        priority?: number;
        alwaysInclude?: boolean;
        triggers?: string[];
        dependsOn?: string[];
        references?: string[];
        provides?: string[];
        when?: string[];
      };

      return {
      id: `lore:${metadata.id ?? loreFile.file.replace(/\.md$/, "")}`,
      source: "lore",
      file: loreFile.file,
      content: loreFile.content,
      priority: metadata.priority ?? (40 - index),
      alwaysInclude: metadata.alwaysInclude,
      triggers: metadata.triggers ?? loreFile.file
        .replace(/\.md$/, "")
        .split(/[^a-zA-Z0-9]+/)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 2),
      dependsOn: metadata.dependsOn,
      references: metadata.references,
      provides: metadata.provides,
      when: metadata.when ?? ["lore"]
    };
    });
  }

  private buildActiveReferencesSection(modules: RouterContextModule[]): string {
    const lines: string[] = [];

    for (const module of modules) {
      const refs = module.references?.slice(0, 8) ?? [];
      const provides = module.provides?.slice(0, 6) ?? [];
      const chunks: string[] = [];

      if (refs.length > 0) {
        chunks.push(`references: ${refs.join(", ")}`);
      }

      if (provides.length > 0) {
        chunks.push(`provides: ${provides.join(", ")}`);
      }

      if (chunks.length > 0) {
        lines.push(`- ${module.id}: ${chunks.join(" | ")}`);
      }
    }

    if (lines.length === 0) {
      return "";
    }

    const header = "## Active References";
    const maxChars = 900;
    const selected: string[] = [];
    let consumed = 0;

    for (const line of lines) {
      if (consumed + line.length > maxChars) break;
      selected.push(line);
      consumed += line.length;
    }

    return selected.length > 0 ? [header, ...selected].join("\n") : "";
  }

  private buildNarratorSection(narratorStyle?: "collaborative" | "balanced" | "strict"): string {
    const style = narratorStyle ?? "balanced";

    const guidelines: Record<typeof style, string> = {
      collaborative: `## Narrator Guidelines (Collaborative)
- Player ability claims are generally trusted when consistent with character abilities
- Confirm player-declared outcomes with brief narrative framing
- You are the co-narrator: amplify and validate player descriptions`,

      balanced: `## Narrator Guidelines (Balanced)
- Player ability claims may be confirmed narratively but require contextual plausibility
- Self-inflicted damage or resource changes by player declaration require DM confirmation
- Do not accept "I take damage" as a fiat; describe the attempt and its actual result
- Validate actions through narrative logic, not player assertion`,

      strict: `## Narrator Guidelines (Strict)
- Player ability claims require narrative confirmation before success
- NEVER accept player-declared damage, HP loss, or resource changes without DM narrative
- Describe attempted actions, do not grant automatic outcomes
- "I cast fireball" becomes: "You begin the incantation..." with potential failure or partial effect
- "I fall and take -5 HP" is ALWAYS ignored; you describe the fall and determine consequences
- You are the independent narrator, not a yes-man to player claims`
    };

    return guidelines[style];
  }

  private isContextRouterEnabled(): boolean {
    const envValue = process.env.DM_CONTEXT_ROUTER_ENABLED;
    if (envValue != null && envValue.trim() !== "") {
      return ["1", "true", "yes", "on"].includes(envValue.trim().toLowerCase());
    }

    const compatibilityFlag = process.env.ENABLE_CONTEXT_ROUTER;
    if (compatibilityFlag != null && compatibilityFlag.trim() !== "") {
      return ["1", "true", "yes", "on"].includes(compatibilityFlag.trim().toLowerCase());
    }

    const config = this.getContextRouterConfig();
    return config?.enabled === true;
  }

  private getContextRouterConfig(): RouterConfig | undefined {
    const dmRecord = this.gameModule.dm as Record<string, unknown>;
    const value = dmRecord.contextRouter;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    const cfg = value as Record<string, unknown>;
    const out: RouterConfig = {};

    if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled;
    if (typeof cfg.contextTokenBudget === "number") out.contextTokenBudget = cfg.contextTokenBudget;
    if (typeof cfg.maxCandidates === "number") out.maxCandidates = cfg.maxCandidates;
    if (typeof cfg.maxSelectedModules === "number") out.maxSelectedModules = cfg.maxSelectedModules;

    return out;
  }

  private getConfiguredContextModules(): RouterContextModule[] {
    const dmRecord = this.gameModule.dm as Record<string, unknown>;
    const value = dmRecord.contextModules;
    if (!Array.isArray(value)) return [];

    return value
      .map((item): RouterContextModule | null => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const obj = item as Record<string, unknown>;
        if (typeof obj.id !== "string" || !obj.id.trim()) return null;
        if (typeof obj.content !== "string" || !obj.content.trim()) return null;

        const module: RouterContextModule = {
          id: obj.id.trim(),
          content: obj.content
        };

        if (typeof obj.priority === "number") module.priority = obj.priority;
        if (typeof obj.alwaysInclude === "boolean") module.alwaysInclude = obj.alwaysInclude;
        if (Array.isArray(obj.triggers)) {
          module.triggers = obj.triggers
            .filter((trigger): trigger is string => typeof trigger === "string")
            .map((trigger) => trigger.trim())
            .filter(Boolean);
        }
        if (Array.isArray(obj.dependsOn)) {
          module.dependsOn = obj.dependsOn
            .filter((dep): dep is string => typeof dep === "string")
            .map((dep) => dep.trim())
            .filter(Boolean);
        }
        if (Array.isArray(obj.references)) {
          module.references = obj.references
            .filter((reference): reference is string => typeof reference === "string")
            .map((reference) => reference.trim())
            .filter(Boolean);
        }
        if (Array.isArray(obj.provides)) {
          module.provides = obj.provides
            .filter((provide): provide is string => typeof provide === "string")
            .map((provide) => provide.trim())
            .filter(Boolean);
        }
        if (Array.isArray(obj.when)) {
          module.when = obj.when
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean);
        }
        if (typeof obj.file === "string") module.file = obj.file;

        return module;
      })
      .filter((module): module is RouterContextModule => Boolean(module));
  }

  private async runSessionHooks(
    hook: "onSessionStart",
    ctx: BaseContext & { characterState: Record<string, unknown> }
  ): Promise<StatePatch> {
    let worldPatch: Record<string, unknown> = {};
    let characterStatePatch: Record<string, unknown> = {};

    for (const mechanic of this.mechanics) {
      const fn = mechanic.hooks?.[hook];
      if (!fn) continue;
      const patch = await fn(ctx);
      if (patch?.worldPatch) {
        worldPatch = { ...worldPatch, ...patch.worldPatch };
        // Update ctx so later mechanics see accumulated state
        ctx = { ...ctx, worldState: { ...ctx.worldState, ...patch.worldPatch } };
      }
      if (patch?.characterState) {
        characterStatePatch = { ...characterStatePatch, ...patch.characterState };
      }
    }

    return {
      worldPatch: Object.keys(worldPatch).length > 0 ? worldPatch : undefined,
      characterState: Object.keys(characterStatePatch).length > 0 ? characterStatePatch : undefined
    };
  }

  private async runSessionEndHooks(ctx: SessionEndContext): Promise<StatePatch> {
    let worldPatch: Record<string, unknown> = {};

    for (const mechanic of this.mechanics) {
      const fn = mechanic.hooks?.onSessionEnd;
      if (!fn) continue;
      const patch = await fn(ctx);
      if (patch?.worldPatch) {
        worldPatch = { ...worldPatch, ...patch.worldPatch };
        ctx = { ...ctx, worldState: { ...ctx.worldState, ...patch.worldPatch } };
      }
    }

    return { worldPatch: Object.keys(worldPatch).length > 0 ? worldPatch : undefined };
  }
}
