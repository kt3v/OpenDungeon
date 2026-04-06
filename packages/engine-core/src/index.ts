import type {
  ActionContext,
  ActionResult,
  BaseContext,
  CharacterCreatedContext,
  CharacterInfo,
  CharacterTemplate,
  GameModule,
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

export { DungeonMasterRuntime } from "./dungeon-master.js";
export type { DmTurnInput, DmTurnResult, DungeonMasterRuntimeOptions } from "./dungeon-master.js";
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
  character: CharacterInfo;
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
}

export interface CharacterCreatedInput {
  tenantId: string;
  campaignId: string;
  playerId: string;
  character: CharacterInfo;
  worldState: Record<string, unknown>;
}

export interface StartSessionInput {
  tenantId: string;
  campaignId: string;
  sessionId: string;
  playerId: string;
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
}

export class EngineRuntime {
  private readonly gameModule: GameModule;
  private readonly dmRuntime: DungeonMasterRuntime;
  private readonly contextRouterRuntime: ContextRouterRuntime;
  private readonly archivistRuntime: ArchivistRuntime;
  /** Effective mechanics list: TypeScript mechanics only. */
  private readonly mechanics: Mechanic[];

  constructor(gameModule: GameModule, options: EngineRuntimeOptions = {}) {
    moduleManifestSchema.parse(gameModule.manifest);
    this.gameModule = gameModule;
    this.mechanics = gameModule.mechanics;

    const provider = options.provider ?? createProviderFromEnv();
    this.dmRuntime = new DungeonMasterRuntime({
      provider,
      moduleConfig: gameModule.dm
    });
    this.contextRouterRuntime = new ContextRouterRuntime(provider);
    this.archivistRuntime = new ArchivistRuntime(provider);
  }

  // -------------------------------------------------------------------------
  // Character lifecycle
  // -------------------------------------------------------------------------

  async onCharacterCreated(input: CharacterCreatedInput): Promise<StatePatch> {
    const ctx: CharacterCreatedContext = {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      playerId: input.playerId,
      character: input.character,
      worldState: input.worldState
    };

    let worldPatch: Record<string, unknown> = {};
    let characterPatch: Record<string, unknown> = {};

    for (const mechanic of this.mechanics) {
      const fn = mechanic.hooks?.onCharacterCreated;
      if (!fn) continue;
      const patch = await fn(ctx);
      if (patch?.worldPatch) {
        worldPatch = { ...worldPatch, ...patch.worldPatch };
        ctx.worldState = { ...ctx.worldState, ...patch.worldPatch };
      }
      if (patch?.characterPatch) {
        characterPatch = { ...characterPatch, ...patch.characterPatch };
      }
    }

    return {
      worldPatch: Object.keys(worldPatch).length > 0 ? worldPatch : undefined,
      characterPatch: Object.keys(characterPatch).length > 0 ? characterPatch : undefined
    };
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async startSession(input: StartSessionInput): Promise<StatePatch> {
    const ctx: BaseContext = {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      playerId: input.playerId,
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
      character: input.character,
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
      result = await mechanicAction();
    } else {
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
    const systemPrompt = await this.buildSystemPrompt(
      ctx.worldState,
      input.actionText,
      input.campaignTitle,
      input.playerLanguage
    );

    const availableMechanicActions = this.mechanics.flatMap((m) =>
      Object.entries(m.actions ?? {}).map(([actionId, actionDef]) => ({
        id: `${m.id}.${actionId}`,
        description: actionDef.description,
        ...(actionDef.paramSchema ? { paramSchema: actionDef.paramSchema } : {})
      }))
    );

    try {
      const dmResult = await this.dmRuntime.runTurn({
        campaignId: input.campaignId,
        sessionId: input.sessionId,
        campaignTitle: input.campaignTitle ?? "",
        playerId: input.playerId,
        actionText: input.actionText,
        worldState: input.worldState,
        recentEvents: input.recentEvents,
        summary: input.summary,
        contextualLore: input.contextualLore,
        lastSuggestedActions: input.lastSuggestedActions,
        availableMechanicActions: availableMechanicActions.length > 0
          ? availableMechanicActions
          : undefined,
        moduleConfig: {
          ...this.gameModule.dm,
          systemPrompt
        }
      });

      // If DM chose to delegate to a mechanic, route there deterministically
      if (dmResult.mechanicCall) {
        const routed = this.findMechanicActionById(dmResult.mechanicCall.id, ctx);
        if (routed) return routed(); // runMechanicAction sets handledByMechanic: true
        // Unknown mechanic id — fall through to DM narrative
      }

      const dmNarrativeResult: ActionResult = {
        message: dmResult.message,
        worldPatch: dmResult.worldPatch,
        summaryPatch: dmResult.summaryPatch,
        suggestedActions: dmResult.suggestedActions
      };

      const archivistResult = await this.archivistRuntime.runTurn({
        actionText: input.actionText,
        worldState: input.worldState,
        dmResult: dmNarrativeResult
      });

      return {
        ...dmNarrativeResult,
        worldPatch: {
          ...(dmNarrativeResult.worldPatch ?? {}),
          ...(archivistResult.worldPatch ?? {})
        },
        summaryPatch: archivistResult.summaryPatch ?? dmNarrativeResult.summaryPatch
      };
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
   * 4. Player language preference instruction
   */
  private async buildSystemPrompt(
    worldState: Record<string, unknown>,
    actionText: string,
    campaignTitle?: string,
    playerLanguage?: string
  ): Promise<string> {
    const { dm, setting } = this.gameModule;

    // Section 1: Setting / World Bible
    const settingSection = renderGameModuleSetting(setting);

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

    // Section 3: Context modules routed per turn
    const routedModules = await this.resolveRoutedContextModules({ actionText, worldState });
    const modulesSection = routedModules.length > 0
      ? [
          "## Active Context Modules",
          ...routedModules.map((module) => `### ${module.id}\n${module.content}`)
        ].join("\n\n")
      : "";

    // Section 4: Language instruction
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
    if (modulesSection) parts.push(modulesSection);

    return parts.join("\n\n");
  }

  private async resolveRoutedContextModules(input: {
    actionText: string;
    worldState: Record<string, unknown>;
  }): Promise<RouterContextModule[]> {
    const modules = this.getConfiguredContextModules();
    if (modules.length === 0) return [];
    if (!this.isContextRouterEnabled()) return [];

    const selection = await this.contextRouterRuntime.selectModules({
      actionText: input.actionText,
      worldState: input.worldState,
      modules,
      config: this.getContextRouterConfig()
    });

    return selection.selectedModules;
  }

  private isContextRouterEnabled(): boolean {
    const envValue = process.env.DM_CONTEXT_ROUTER_ENABLED;
    if (envValue != null) {
      return ["1", "true", "yes", "on"].includes(envValue.trim().toLowerCase());
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
        if (typeof obj.file === "string") module.file = obj.file;

        return module;
      })
      .filter((module): module is RouterContextModule => Boolean(module));
  }

  private async runSessionHooks(
    hook: "onSessionStart",
    ctx: BaseContext
  ): Promise<StatePatch> {
    let worldPatch: Record<string, unknown> = {};
    let characterPatch: Record<string, unknown> = {};

    for (const mechanic of this.mechanics) {
      const fn = mechanic.hooks?.[hook];
      if (!fn) continue;
      const patch = await fn(ctx);
      if (patch?.worldPatch) {
        worldPatch = { ...worldPatch, ...patch.worldPatch };
        // Update ctx so later mechanics see accumulated state
        ctx = { ...ctx, worldState: { ...ctx.worldState, ...patch.worldPatch } };
      }
      if (patch?.characterPatch) {
        characterPatch = { ...characterPatch, ...patch.characterPatch };
      }
    }

    return {
      worldPatch: Object.keys(worldPatch).length > 0 ? worldPatch : undefined,
      characterPatch: Object.keys(characterPatch).length > 0 ? characterPatch : undefined
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
