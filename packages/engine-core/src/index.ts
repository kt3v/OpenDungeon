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
import { renderDungeonMasterPromptTemplate } from "@opendungeon/content-sdk";
import type { SessionEndReason } from "@opendungeon/shared";
import { moduleManifestSchema } from "@opendungeon/shared";
import { createProviderFromEnv, type LlmProvider } from "@opendungeon/providers-llm";
import { DungeonMasterRuntime } from "./dungeon-master.js";

export { DungeonMasterRuntime } from "./dungeon-master.js";
export type { DmTurnInput, DmTurnResult, DungeonMasterRuntimeOptions } from "./dungeon-master.js";

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

  constructor(gameModule: GameModule, options: EngineRuntimeOptions = {}) {
    moduleManifestSchema.parse(gameModule.manifest);
    this.gameModule = gameModule;

    const provider = options.provider ?? createProviderFromEnv();
    this.dmRuntime = new DungeonMasterRuntime({
      provider,
      moduleConfig: gameModule.dm
    });
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

    for (const mechanic of this.gameModule.mechanics) {
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
    for (const mechanic of this.gameModule.mechanics) {
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
    for (const mechanic of this.gameModule.mechanics) {
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
   * Find the mechanic action resolver for the given PlayerAction.
   * Returns a zero-arg function that runs the action, or null if not found.
   */
  private resolveMechanicAction(
    action: PlayerAction,
    ctx: ActionContext
  ): (() => Promise<ActionResult>) | null {
    // Priority 1: explicit mechanicActionId e.g. "extraction.extract"
    if (action.mechanicActionId) {
      const [mechanicId, actionId] = action.mechanicActionId.split(".");
      const mechanic = this.gameModule.mechanics.find((m) => m.id === mechanicId);
      const actionDef = mechanic?.actions?.[actionId ?? ""];
      if (actionDef) {
        return () => this.runMechanicAction(mechanic!, actionId!, actionDef, ctx);
      }
    }

    // Priority 2: action text matches a registered action id (case-insensitive)
    const textLower = action.text.trim().toLowerCase();
    for (const mechanic of this.gameModule.mechanics) {
      if (!mechanic.actions) continue;
      for (const [actionId, actionDef] of Object.entries(mechanic.actions)) {
        if (actionId.toLowerCase() === textLower) {
          return () => this.runMechanicAction(mechanic, actionId, actionDef, ctx);
        }
      }
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
    return actionDef.resolve(ctx);
  }

  private async runDm(
    input: ExecuteTurnInput,
    ctx: ActionContext
  ): Promise<ActionResult> {
    const systemPrompt = this.buildSystemPrompt(ctx.worldState, input.campaignTitle);

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
        moduleConfig: {
          ...this.gameModule.dm,
          systemPrompt
        }
      });

      return {
        message: dmResult.message,
        worldPatch: dmResult.worldPatch,
        summaryPatch: dmResult.summaryPatch,
        suggestedActions: dmResult.suggestedActions
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
   * Build the final DM system prompt by combining the module base prompt
   * with each mechanic's dmPromptExtension.
   */
  private buildSystemPrompt(
    worldState: Record<string, unknown>,
    campaignTitle?: string
  ): string {
    const { dm } = this.gameModule;

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

    const extensions = this.gameModule.mechanics
      .filter((m) => typeof m.dmPromptExtension === "function")
      .map((m) => m.dmPromptExtension!({ worldState }))
      .filter(Boolean);

    return extensions.length > 0 ? `${base}\n\n${extensions.join("\n\n")}` : base;
  }

  private async runSessionHooks(
    hook: "onSessionStart",
    ctx: BaseContext
  ): Promise<StatePatch> {
    let worldPatch: Record<string, unknown> = {};
    let characterPatch: Record<string, unknown> = {};

    for (const mechanic of this.gameModule.mechanics) {
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

    for (const mechanic of this.gameModule.mechanics) {
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
