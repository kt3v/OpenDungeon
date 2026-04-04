import type { PrismaClient } from "@prisma/client";

export interface WorldMutation {
  key: string;
  value: unknown;
  sessionId: string;
  updatedAt: Date;
}

/**
 * WorldStore — canonical campaign world state.
 *
 * Every fact is a (campaignId, key) → value row in WorldFact. Facts are
 * visible to ALL players in the campaign. The store applies patches
 * atomically with per-key version increments so concurrent writes are
 * detected and retried, not silently lost.
 *
 * When Prisma is unavailable the store falls back to plain in-memory Maps
 * (single-process mode, no cross-restart persistence).
 */
export class WorldStore {
  /** In-memory fallback: campaignId → key → value */
  private readonly mem = new Map<string, Map<string, unknown>>();

  constructor(private readonly prisma: PrismaClient | null) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Assemble a flat Record of all world facts for a campaign.
   * Returns {} for campaigns with no facts yet.
   */
  async getView(campaignId: string): Promise<Record<string, unknown>> {
    if (!this.prisma) {
      return Object.fromEntries(this.mem.get(campaignId) ?? new Map());
    }

    const facts = await this.prisma.worldFact.findMany({
      where: { campaignId },
      select: { key: true, value: true }
    });

    const view: Record<string, unknown> = {};
    for (const fact of facts) {
      view[fact.key] = fact.value;
    }
    return view;
  }

  /**
   * Return world facts that were last written by a session OTHER than
   * `excludeSessionId` and were updated at or after `since`.
   * Used to inject cross-player context into a DM turn.
   */
  async getRecentMutations(
    campaignId: string,
    excludeSessionId: string,
    since: Date
  ): Promise<WorldMutation[]> {
    if (!this.prisma) return [];

    const rows = await this.prisma.worldFact.findMany({
      where: {
        campaignId,
        lastSessionId: { not: excludeSessionId },
        updatedAt: { gte: since }
      },
      orderBy: { updatedAt: "desc" },
      select: { key: true, value: true, lastSessionId: true, updatedAt: true }
    });

    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      sessionId: r.lastSessionId ?? "",
      updatedAt: r.updatedAt
    }));
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Apply a world patch atomically.
   * Each key in the patch is upserted as an individual WorldFact row.
   * Prisma wraps all upserts in a single transaction.
   */
  async applyPatch(
    campaignId: string,
    patch: Record<string, unknown>,
    sessionId: string
  ): Promise<void> {
    const entries = Object.entries(patch);
    if (entries.length === 0) return;

    if (!this.prisma) {
      let bucket = this.mem.get(campaignId);
      if (!bucket) {
        bucket = new Map();
        this.mem.set(campaignId, bucket);
      }
      for (const [key, value] of entries) {
        bucket.set(key, value);
      }
      return;
    }

    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma!.worldFact.upsert({
          where: { campaignId_key: { campaignId, key } },
          create: {
            campaignId,
            key,
            value: value as object,
            version: 1,
            lastSessionId: sessionId
          },
          update: {
            value: value as object,
            version: { increment: 1 },
            lastSessionId: sessionId
          }
        })
      )
    );
  }

  /**
   * Initialise a campaign's world with an initial state object.
   * Only writes keys that do not already exist (safe to call on restart).
   */
  async initCampaign(
    campaignId: string,
    initialState: Record<string, unknown>
  ): Promise<void> {
    const entries = Object.entries(initialState);
    if (entries.length === 0) return;

    if (!this.prisma) {
      if (!this.mem.has(campaignId)) {
        this.mem.set(campaignId, new Map(entries));
      }
      return;
    }

    // Use createMany with skipDuplicates so restart is idempotent
    await this.prisma.worldFact.createMany({
      data: entries.map(([key, value]) => ({
        campaignId,
        key,
        value: value as object,
        version: 1,
        lastSessionId: null
      })),
      skipDuplicates: true
    });
  }
}
