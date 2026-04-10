import type { PrismaClient } from "@prisma/client";
import type { StateOperation, StateVariable } from "@opendungeon/content-sdk";

export interface WorldMutation {
  key: string;
  value: unknown;
  sessionId: string;
  updatedAt: Date;
}

type ActorType = "dm" | "mechanic" | "system";

export class WorldStore {
  private readonly worldMem = new Map<string, Map<string, unknown>>();
  private readonly characterMem = new Map<string, Map<string, unknown>>();
  private readonly sessionMem = new Map<string, Map<string, unknown>>();

  constructor(private readonly prisma: PrismaClient | null) {}

  async syncStateCatalog(moduleName: string, moduleVersion: string, variables: StateVariable[]): Promise<void> {
    if (!this.prisma || variables.length === 0) return;
    await this.prisma.$transaction(
      variables.map((variable) =>
        this.prisma!.stateVariableDef.upsert({
          where: { moduleName_moduleVersion_varId: { moduleName, moduleVersion, varId: variable.id } },
          create: {
            moduleName,
            moduleVersion,
            varId: variable.id,
            scope: variable.scope,
            valueType: variable.type,
            defaultValue: variable.defaultValue as object | undefined,
            writableBy: (variable.writableBy ?? ["dm", "mechanic", "system"]) as object
          },
          update: {
            scope: variable.scope,
            valueType: variable.type,
            defaultValue: variable.defaultValue as object | undefined,
            writableBy: (variable.writableBy ?? ["dm", "mechanic", "system"]) as object
          }
        })
      )
    );
  }

  async getView(campaignId: string): Promise<Record<string, unknown>> {
    if (!this.prisma) {
      return Object.fromEntries(this.worldMem.get(campaignId) ?? new Map());
    }

    const rows = await this.prisma.stateValue.findMany({
      where: { campaignId, scope: "world", sessionId: "" },
      select: { varId: true, value: true }
    });

    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.varId] = row.value;
    return out;
  }

  async getCharacterView(campaignId: string, sessionId: string): Promise<Record<string, unknown>> {
    const key = `${campaignId}:${sessionId}`;
    if (!this.prisma) {
      return Object.fromEntries(this.characterMem.get(key) ?? new Map());
    }

    const rows = await this.prisma.stateValue.findMany({
      where: { campaignId, scope: "character", sessionId },
      select: { varId: true, value: true }
    });
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.varId] = row.value;
    return out;
  }

  async getSessionView(campaignId: string, sessionId: string): Promise<Record<string, unknown>> {
    const key = `${campaignId}:${sessionId}`;
    if (!this.prisma) {
      return Object.fromEntries(this.sessionMem.get(key) ?? new Map());
    }

    const rows = await this.prisma.stateValue.findMany({
      where: { campaignId, scope: "session", sessionId },
      select: { varId: true, value: true }
    });
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.varId] = row.value;
    return out;
  }

  async getRecentMutations(campaignId: string, excludeSessionId: string, since: Date): Promise<WorldMutation[]> {
    if (!this.prisma) return [];

    const rows = await this.prisma.stateValue.findMany({
      where: {
        campaignId,
        scope: "world",
        sessionId: "",
        lastSessionId: { not: excludeSessionId },
        updatedAt: { gte: since }
      },
      orderBy: { updatedAt: "desc" },
      select: { varId: true, value: true, lastSessionId: true, updatedAt: true }
    });

    return rows.map((row) => ({
      key: row.varId,
      value: row.value,
      sessionId: row.lastSessionId ?? "",
      updatedAt: row.updatedAt
    }));
  }

  async applyPatch(campaignId: string, patch: Record<string, unknown>, sessionId: string): Promise<void> {
    const entries = Object.entries(patch);
    if (entries.length === 0) return;

    if (!this.prisma) {
      let bucket = this.worldMem.get(campaignId);
      if (!bucket) {
        bucket = new Map();
        this.worldMem.set(campaignId, bucket);
      }
      for (const [key, value] of entries) bucket.set(key, value);
      return;
    }

    await this.prisma.$transaction(
      entries.map(([varId, value]) =>
        this.prisma!.stateValue.upsert({
          where: { campaignId_scope_sessionId_varId: { campaignId, scope: "world", sessionId: "", varId } },
          create: {
            campaignId,
            sessionId: "",
            scope: "world",
            varId,
            value: value as object,
            revision: 1,
            lastSessionId: sessionId
          },
          update: {
            value: value as object,
            revision: { increment: 1 },
            lastSessionId: sessionId
          }
        })
      )
    );
  }

  async upsertScopedState(input: {
    campaignId: string;
    sessionId: string;
    scope: "character" | "session";
    state: Record<string, unknown>;
    lastSessionId?: string;
  }): Promise<void> {
    const entries = Object.entries(input.state);
    if (entries.length === 0) return;

    const memKey = `${input.campaignId}:${input.sessionId}`;
    if (!this.prisma) {
      const bucketMap = input.scope === "character" ? this.characterMem : this.sessionMem;
      let bucket = bucketMap.get(memKey);
      if (!bucket) {
        bucket = new Map();
        bucketMap.set(memKey, bucket);
      }
      for (const [key, value] of entries) bucket.set(key, value);
      return;
    }

    await this.prisma.$transaction(
      entries.map(([varId, value]) =>
        this.prisma!.stateValue.upsert({
          where: {
            campaignId_scope_sessionId_varId: {
              campaignId: input.campaignId,
              scope: input.scope,
              sessionId: input.sessionId,
              varId
            }
          },
          create: {
            campaignId: input.campaignId,
            sessionId: input.sessionId,
            scope: input.scope,
            varId,
            value: value as object,
            revision: 1,
            lastSessionId: input.lastSessionId ?? input.sessionId
          },
          update: {
            value: value as object,
            revision: { increment: 1 },
            lastSessionId: input.lastSessionId ?? input.sessionId
          }
        })
      )
    );
  }

  async logOperations(input: {
    campaignId: string;
    sessionId: string;
    actor: ActorType;
    source: string;
    operations: StateOperation[];
    variables: StateVariable[];
    valueBefore: Record<string, unknown>;
    valueAfter: Record<string, unknown>;
  }): Promise<void> {
    if (!this.prisma || input.operations.length === 0) return;
    const defs = new Map(input.variables.map((v) => [v.id, v]));

    await this.prisma.stateMutationLog.createMany({
      data: input.operations
        .map((op) => {
          const def = defs.get(op.varId);
          if (!def) return null;
          return {
            campaignId: input.campaignId,
            sessionId: input.sessionId,
            actorType: input.actor,
            op: op.op,
            scope: def.scope,
            varId: op.varId,
            valueBefore: input.valueBefore[op.varId] as object | undefined,
            valueAfter: input.valueAfter[op.varId] as object | undefined,
            source: input.source
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
    });
  }

  async initCampaign(campaignId: string, initialState: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(initialState);
    if (entries.length === 0) return;

    if (!this.prisma) {
      if (!this.worldMem.has(campaignId)) {
        this.worldMem.set(campaignId, new Map(entries));
      }
      return;
    }

    await this.prisma.stateValue.createMany({
      data: entries.map(([varId, value]) => ({
        campaignId,
        sessionId: "",
        scope: "world",
        varId,
        value: value as object,
        revision: 1,
        lastSessionId: null
      })),
      skipDuplicates: true
    });
  }
}
