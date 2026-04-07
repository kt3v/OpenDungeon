import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { EngineRuntime, LoreEntryPayload } from "@opendungeon/engine-core";
import { extractLore } from "@opendungeon/engine-core";
import { createProviderFromEnv } from "@opendungeon/providers-llm";
import type { SessionEndReason } from "@opendungeon/shared";
import type { ArchitectRuntime, ArchitectOperationExecutor } from "@opendungeon/architect";
import { serverConfig } from "./server-config.js";
import type { WorldStore } from "./world-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ActionStatus = "pending" | "processing" | "done" | "failed";

export interface QueuedActionResult {
  event: {
    id: string;
    createdAt: string;
    playerId: string;
    actionText: string;
    message: string;
  };
  characterState: Record<string, unknown>;
  sessionEnded?: { reason: SessionEndReason };
}

export interface QueueEntry {
  id: string;
  sessionId: string;
  campaignId: string;
  status: ActionStatus;
  result?: QueuedActionResult;
  errorMessage?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Session snapshot passed in from the gateway
// (subset of in-memory Session needed by the processor)
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  id: string;
  campaignId: string;
  userId: string;
  characterName: string;
  characterClass: string;
  /// Player's current location - personal state, not shared across campaign
  location: string;
  /// Unified character state: hp, level, attributes, inventory + ephemeral data
  characterState: Record<string, unknown>;
  status: "active" | "ended";
  summary?: string;
  recentEvents: Array<{
    id: string;
    createdAt: string;
    playerId: string;
    actionText: string;
    message: string;
  }>;
  suggestedActions: Array<{ id: string; label: string; prompt: string }>;
  /**
   * Player's preferred language for DM responses.
   */
  userLanguage?: string;
}

export interface CampaignSnapshot {
  id: string;
  title: string;
  ownerId: string;
  moduleName: string;
  moduleVersion: string;
}

// ---------------------------------------------------------------------------
// Callbacks the gateway provides so the processor can mutate in-memory state
// ---------------------------------------------------------------------------

export interface ProcessorCallbacks {
  getSession(sessionId: string): SessionSnapshot | undefined;
  getCampaign(campaignId: string): CampaignSnapshot | undefined;
  /** Apply result patches to in-memory session and persist to DB */
  commitSessionMutation(
    sessionId: string,
    mutation: {
      characterState?: Record<string, unknown>;
      location?: string;
      summary?: string;
      suggestedActions?: Array<{ id: string; label: string; prompt: string }>;
      appendEvent: {
        id: string;
        createdAt: string;
        playerId: string;
        actionText: string;
        message: string;
      };
      endSession?: SessionEndReason;
    }
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// ActionProcessor
// ---------------------------------------------------------------------------

export class ActionProcessor {
  /** In-memory index of all queued actions for fast polling. */
  private readonly queue = new Map<string, QueueEntry>();

  /** Count of actions currently being processed (for graceful drain on reload). */
  private activeCount = 0;

  /**
   * Per-campaign commit chain.
   * LLM calls run freely in parallel; world-state commits are serialised
   * by chaining promises per campaignId so patches never overwrite each other.
   */
  private readonly commitChains = new Map<string, Promise<void>>();

  /**
   * Per-campaign chronicler chain (separate from commitChains).
   * Serialises chronicler runs per campaign so concurrent player sessions
   * don't produce duplicate milestones or double-appended archives.
   * Kept separate so slow LLM chronicler calls don't block world-state commits.
   */
  private readonly chroniclerChains = new Map<string, Promise<void>>();

  constructor(
    private readonly runtime: EngineRuntime,
    private readonly worldStore: WorldStore,
    private readonly prisma: PrismaClient | null,
    private readonly callbacks: ProcessorCallbacks,
    private readonly architect?: {
      runtime: ArchitectRuntime;
      executor: ArchitectOperationExecutor;
    }
  ) {}

  // ---------------------------------------------------------------------------
  // Enqueue
  // ---------------------------------------------------------------------------

  /**
   * Enqueue an action and immediately start async processing.
   * Returns the action ID for polling.
   */
  enqueue(
    sessionId: string,
    campaignId: string,
    actionText: string,
    mechanicActionId: string | undefined
  ): string {
    const entry: QueueEntry = {
      id: randomUUID(),
      sessionId,
      campaignId,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    this.queue.set(entry.id, entry);

    // Persist to DB (fire-and-forget — we don't await here so the HTTP
    // response can return the actionId immediately)
    if (this.prisma) {
      this.prisma.actionQueue
        .create({
          data: {
            id: entry.id,
            sessionId,
            campaignId,
            actionText,
            mechanicActionId: mechanicActionId ?? null,
            status: "pending"
          }
        })
        .catch((err: unknown) => console.error("[ActionProcessor] DB enqueue failed:", err));
    }

    // Start processing without blocking the caller
    this.processAsync(entry.id, sessionId, campaignId, actionText, mechanicActionId).catch(
      (err: unknown) => console.error("[ActionProcessor] processAsync error:", err)
    );

    return entry.id;
  }

  // ---------------------------------------------------------------------------
  // Poll
  // ---------------------------------------------------------------------------

  get(actionId: string): QueueEntry | undefined {
    return this.queue.get(actionId);
  }

  /**
   * Wait until all in-flight actions complete, or until timeoutMs elapses.
   * Returns true if drained cleanly, false if timed out.
   */
  async drain(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeCount > 0) {
      if (Date.now() > deadline) return false;
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Core async pipeline
  // ---------------------------------------------------------------------------

  private async processAsync(
    actionId: string,
    sessionId: string,
    campaignId: string,
    actionText: string,
    mechanicActionId: string | undefined
  ): Promise<void> {
    const entry = this.queue.get(actionId);
    if (!entry) return;

    entry.status = "processing";
    this.activeCount++;

    try {
      const session = this.callbacks.getSession(sessionId);
      const campaign = this.callbacks.getCampaign(campaignId);

      if (!session || !campaign) {
        throw new Error("Session or campaign not found at processing time");
      }

      // ------------------------------------------------------------------
      // Phase A — Read (can run concurrently across campaigns)
      // ------------------------------------------------------------------

      // Canonical world view from DB
      const worldView = await this.worldStore.getView(campaignId);

      // Character-local state overlays the shared world view
      // This gives the DM a merged context while keeping things separated
      const mergedWorldState = { ...worldView, ...session.characterState };

      // Recent mutations from OTHER players (cross-player awareness)
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
      const recentMutations = await this.worldStore.getRecentMutations(
        campaignId,
        sessionId,
        since
      );

      // RAG: lore retrieval
      let contextualLore: string | undefined;
      if (this.prisma) {
        try {
          const allLore = await this.prisma.loreEntry.findMany({
            where: { campaignId }
          });
          const actionLower = actionText.toLowerCase();
          const matching = allLore.filter((l: { entityName: string }) =>
            actionLower.includes(l.entityName.toLowerCase())
          );
          const parts: string[] = matching.map(
            (l: { entityName: string; type: string; description: string }) => `${l.entityName} (${l.type}): ${l.description}`
          );

          // Inject cross-player world mutations as contextual lore
          if (recentMutations.length > 0) {
            const mutationLines = recentMutations
              .slice(0, 10)
              .map((m) => `World change — ${m.key}: ${JSON.stringify(m.value)}`)
              .join("\n");
            parts.push(`Recent world changes by other adventurers:\n${mutationLines}`);
          }

          if (parts.length > 0) contextualLore = parts.join("\n");
        } catch (err) {
          console.warn("[ActionProcessor] RAG retrieval failed:", err);
        }
      }

      // ------------------------------------------------------------------
      // Phase B — LLM execution (runs in parallel, no campaign lock needed)
      // ------------------------------------------------------------------

      // Build character state for the engine
      const characterStateForTurn = {
        ...session.characterState,
        id: session.id,
        name: session.characterName,
        className: session.characterClass
      };

      const result = await this.runtime.executeTurn({
        tenantId: campaign.ownerId,
        campaignId,
        sessionId,
        playerId: session.userId,
        characterState: characterStateForTurn,
        location: session.location,
        actionText,
        mechanicActionId,
        worldState: mergedWorldState,
        recentEvents: session.recentEvents.slice(-20),
        campaignTitle: campaign.title,
        summary: session.summary,
        contextualLore,
        lastSuggestedActions: session.suggestedActions,
        playerLanguage: session.userLanguage
      });

      // Log unhandled intents (fire-and-forget, no await — does not block the turn)
      // An intent is "unhandled" when no mechanic handled it AND the client
      // didn't explicitly route to one. The DM narrated freely instead.
      if (!result.handledByMechanic && !mechanicActionId && this.prisma) {
        void this.prisma.eventLog.create({
          data: {
            campaignId,
            sessionId,
            type: "intent.unhandled",
            payload: { actionText } as object
          }
        });
      }

      // ------------------------------------------------------------------
      // Phase C — Commit (serialised per campaign via promise chain)
      // ------------------------------------------------------------------

      await this.withCampaignLock(campaignId, async () => {
        // Write shared world patch to canonical WorldFact store
        if (result.worldPatch && Object.keys(result.worldPatch).length > 0) {
          await this.worldStore.applyPatch(campaignId, result.worldPatch, sessionId);
        }

        // Handle session end (run hooks before committing end state)
        let endSessionReason: SessionEndReason | undefined;
        let endWorldPatch: Record<string, unknown> | undefined;

        if (result.endSession) {
          const endPatch = await this.runtime.endSession({
            tenantId: campaign.ownerId,
            campaignId,
            sessionId,
            playerId: session.userId,
            reason: result.endSession,
            worldState: mergedWorldState
          });

          if (endPatch.worldPatch && Object.keys(endPatch.worldPatch).length > 0) {
            await this.worldStore.applyPatch(campaignId, endPatch.worldPatch, sessionId);
            endWorldPatch = endPatch.worldPatch;
          }

          endSessionReason = result.endSession;
        }

        // Build the event record
        const event = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          playerId: session.userId,
          actionText,
          message: result.message
        };

        // Build new characterState by merging:
        // 1. Current state
        // 2. Any patches from mechanics (hp/level are already in characterState from engine)
        const newCharacterState: Record<string, unknown> = {
          ...session.characterState,
          ...(result.characterState ?? {})
        };

        // Commit session mutation (persists to DB and updates in-memory)
        await this.callbacks.commitSessionMutation(sessionId, {
          characterState: newCharacterState,
          location: result.location,
          summary: result.summaryPatch?.shortSummary ?? session.summary,
          suggestedActions:
            result.suggestedActions && result.suggestedActions.length > 0
              ? result.suggestedActions
              : undefined,
          appendEvent: event,
          endSession: endSessionReason
        });

        // Persist event to EventLog
        if (this.prisma) {
          await this.prisma.eventLog.create({
            data: {
              campaignId,
              sessionId,
              type: "action.resolved",
              payload: JSON.parse(JSON.stringify({
                actionId,
                playerId: session.userId,
                actionText,
                message: result.message,
                hadWorldPatch: !!result.worldPatch,
                hadCharacterState: !!(result as { characterState?: unknown }).characterState,
                endSession: endSessionReason ?? null,
                endWorldPatch: endWorldPatch ?? null
              })) as object
            }
          });

          // Update ActionQueue row status
          await this.prisma.actionQueue
            .update({
              where: { id: actionId },
              data: {
                status: "done",
                processedAt: new Date(),
                result: JSON.parse(JSON.stringify({
                  event,
                  characterState: newCharacterState,
                  sessionEnded: endSessionReason ? { reason: endSessionReason } : undefined
                })) as object
              }
            })
            .catch((err: unknown) =>
              console.warn("[ActionProcessor] DB status update failed:", err)
            );
        }

        // Store result in-memory for polling
        entry.status = "done";
        entry.result = {
          event,
          characterState: newCharacterState,
          sessionEnded: endSessionReason ? { reason: endSessionReason } : undefined
        };

        // Human-readable log
        const oldHp = session.characterState.hp as number;
        const oldLevel = session.characterState.level as number;
        const newHp = newCharacterState.hp as number;
        const newLevel = newCharacterState.level as number;
        const hpChanged = newHp !== oldHp;
        const levelChanged = newLevel !== oldLevel;

        if (endSessionReason) {
          console.log(`[EVENT] CHARACTER_${endSessionReason.toUpperCase()}`, JSON.stringify({
            characterName: session.characterName,
            campaignId,
            sessionId,
            message: result.message?.slice(0, 100) + (result.message && result.message.length > 100 ? "..." : "")
          }, null, 0));
        } else {
          const changes: string[] = [];
          if (hpChanged) changes.push(`HP: ${oldHp} → ${newHp}`);
          if (levelChanged) changes.push(`Level: ${oldLevel} → ${newLevel}`);
          if (result.summaryPatch?.shortSummary) changes.push("Summary updated");

          console.log(`[EVENT] ACTION_RESOLVED`, JSON.stringify({
            characterName: session.characterName,
            action: actionText,
            message: result.message?.slice(0, 80) + (result.message && result.message.length > 80 ? "..." : ""),
            changes: changes.length > 0 ? changes : undefined
          }, null, 0));
        }
      });

      // Background: lore extraction + chronicler (fire-and-forget)
      this.runBackgroundTasks(
        sessionId,
        campaignId,
        actionText,
        result.message,
        session.recentEvents.length + 1,
        !!result.endSession
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.status = "failed";
      entry.errorMessage = msg;
      
      const session = this.callbacks.getSession(sessionId);
      console.log(`[EVENT] ACTION_FAILED`, JSON.stringify({
        characterName: session?.characterName ?? "unknown",
        action: actionText,
        error: msg
      }, null, 0));

      if (this.prisma) {
        this.prisma.actionQueue
          .update({
            where: { id: actionId },
            data: { status: "failed", errorMessage: msg, processedAt: new Date() }
          })
          .catch(() => {});
      }
    } finally {
      this.activeCount--;
    }
  }

  // ---------------------------------------------------------------------------
  // Campaign commit lock (simple promise-chain mutex)
  // ---------------------------------------------------------------------------

  private async withCampaignLock(
    campaignId: string,
    fn: () => Promise<void>
  ): Promise<void> {
    const prev = this.commitChains.get(campaignId) ?? Promise.resolve();

    let resolveLock!: () => void;
    const lock = new Promise<void>((r) => {
      resolveLock = r;
    });

    // Chain this lock onto the previous one
    this.commitChains.set(campaignId, lock);

    try {
      await prev; // wait for any prior commit to finish
      await fn(); // run the actual commit
    } finally {
      resolveLock(); // release for the next waiter
    }
  }

  // ---------------------------------------------------------------------------
  // Background tasks (lore extraction + session compression)
  // ---------------------------------------------------------------------------

  private runBackgroundTasks(
    sessionId: string,
    campaignId: string,
    actionText: string,
    responseMessage: string,
    eventCount: number,
    isSessionEnd: boolean
  ): void {
    if (!this.prisma) return;

    const llmProvider = createProviderFromEnv();

    // Tier 1: lore extraction every turn — atomic upsert via executor (or naive fallback)
    extractLore(llmProvider, actionText, responseMessage)
      .then(async (entities: LoreEntryPayload[]) => {
        if (this.architect) {
          const ops = entities.map((ent) => ({
            op: "upsert_lore" as const,
            entityName: ent.entityName,
            type: ent.type as "NPC" | "Location" | "Item" | "Faction" | "Lore",
            description: ent.description,
            authoritative: false
          }));
          await this.architect.executor.execute(ops, campaignId);
        } else {
          // Graceful fallback: naive upsert without architect
          for (const ent of entities) {
            await this.prisma!.loreEntry.upsert({
              where: { campaignId_entityName: { campaignId, entityName: ent.entityName } },
              create: { campaignId, entityName: ent.entityName, type: ent.type, description: ent.description },
              update: {}
            });
          }
        }
      })
      .catch((err: unknown) => console.error("[ActionProcessor] lore extraction failed:", err));

    // Tier 2: chronicler on interval or at session end (serialised per campaign)
    const interval = serverConfig.chroniclerEventInterval;
    const periodicTrigger = interval > 0 && eventCount % interval === 0 && eventCount > 0;
    if (this.architect && (isSessionEnd || periodicTrigger)) {
      this.runChroniclerTask(sessionId, campaignId);
    }
  }

  private runChroniclerTask(sessionId: string, campaignId: string): void {
    const prev = this.chroniclerChains.get(campaignId) ?? Promise.resolve();

    let resolveLock!: () => void;
    const lock = new Promise<void>((r) => { resolveLock = r; });
    this.chroniclerChains.set(campaignId, lock);

    prev
      .then(() => this.executeChronicler(sessionId, campaignId))
      .catch((err: unknown) => console.error("[ActionProcessor] chronicler task failed:", err))
      .finally(() => resolveLock());
  }

  private async executeChronicler(sessionId: string, campaignId: string): Promise<void> {
    if (!this.architect || !this.prisma) return;

    const session = this.callbacks.getSession(sessionId);
    if (!session) return;

    const allLore = await this.prisma.loreEntry.findMany({ where: { campaignId } });
    const worldView = await this.worldStore.getView(campaignId);

    const result = await this.architect.runtime.runChronicler({
      campaignId,
      sessionId,
      recentEvents: session.recentEvents.slice(-20),
      existingLore: allLore.map((l: { entityName: string; type: string; description: string }) => ({
        entityName: l.entityName,
        type: l.type,
        description: l.description
      })),
      currentWorldState: worldView
    });

    if (result.operations.length > 0) {
      const report = await this.architect.executor.execute(result.operations, campaignId);
      if (report.errors.length > 0) {
        console.warn("[ActionProcessor] chronicler had errors:", report.errors.length);
      }
    }
  }
}
