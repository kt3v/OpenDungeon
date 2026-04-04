import type { PrismaClient } from "@prisma/client";
import type { ArchitectOperation, LoreSource } from "./operations.js";

export interface ExecutionReport {
  applied: number;
  skipped: number;
  errors: Array<{ op: ArchitectOperation; reason: string }>;
}

/**
 * The single writer for all Architect operations.
 * Both Mode 1 (developer CLI) and Mode 2 (chronicler) route through this class,
 * ensuring world state and lore are written with identical conventions.
 */
export class ArchitectOperationExecutor {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(ops: ArchitectOperation[], campaignId: string): Promise<ExecutionReport> {
    const report: ExecutionReport = { applied: 0, skipped: 0, errors: [] };

    for (const op of ops) {
      try {
        await this.executeOne(op, campaignId);
        report.applied += 1;
      } catch (err) {
        report.errors.push({ op, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return report;
  }

  private async executeOne(op: ArchitectOperation, campaignId: string): Promise<void> {
    switch (op.op) {
      case "upsert_lore": {
        await this.upsertLore(campaignId, op.entityName, op.type, op.description, op.authoritative);
        break;
      }

      case "set_world_fact": {
        const sourceSessionId = `architect:${op.sourceTag}`;
        // Mirror the WorldStore.applyPatch logic, writing directly via Prisma
        await this.prisma.worldFact.upsert({
          where: { campaignId_key: { campaignId, key: op.key } },
          create: {
            campaignId,
            key: op.key,
            value: JSON.parse(JSON.stringify(op.value)) as object,
            version: 1,
            lastSessionId: sourceSessionId
          },
          update: {
            value: JSON.parse(JSON.stringify(op.value)) as object,
            version: { increment: 1 },
            lastSessionId: sourceSessionId
          }
        });
        break;
      }

      case "append_session_archive": {
        const current = await this.prisma.session.findUnique({
          where: { id: op.sessionId },
          select: { archive: true }
        });
        if (!current) throw new Error(`Session ${op.sessionId} not found`);
        const newArchive = current.archive ? `${current.archive}\n\n${op.text}` : op.text;
        await this.prisma.session.update({
          where: { id: op.sessionId },
          data: { archive: newArchive }
        });
        break;
      }

      case "append_campaign_archive": {
        // Atomic concatenation — no read-then-write race when multiple player
        // sessions trigger the chronicler concurrently in the same campaign.
        await this.prisma.$executeRaw`
          UPDATE "Campaign"
          SET "campaignArchive" = CASE
            WHEN "campaignArchive" IS NULL THEN ${op.text}
            ELSE "campaignArchive" || E'\n\n' || ${op.text}
          END
          WHERE "id" = ${campaignId}::uuid
        `;
        break;
      }

      case "create_milestone": {
        await this.prisma.milestone.create({
          data: {
            campaignId,
            sessionId: op.sessionId ?? null,
            title: op.title,
            description: op.description,
            milestoneType: op.milestoneType
          }
        });
        break;
      }

      case "resolve_lore_conflict": {
        const existing = await this.prisma.loreEntry.findUnique({
          where: { campaignId_entityName: { campaignId, entityName: op.entityName } }
        });
        if (!existing) {
          throw new Error(`LoreEntry not found for conflict resolution: ${op.entityName}`);
        }
        await this.prisma.loreEntry.update({
          where: { campaignId_entityName: { campaignId, entityName: op.entityName } },
          data: {
            description: op.canonicalDescription,
            source: "chronicler" satisfies LoreSource,
            version: { increment: 1 }
          }
        });
        break;
      }
    }
  }

  private async upsertLore(
    campaignId: string,
    entityName: string,
    type: string,
    description: string,
    authoritative = false
  ): Promise<void> {
    if (authoritative) {
      // Authoritative write: always overwrite with new description
      await this.prisma.loreEntry.upsert({
        where: { campaignId_entityName: { campaignId, entityName } },
        create: { campaignId, entityName, type, description, source: "chronicler" satisfies LoreSource, version: 1 },
        update: { description, type, source: "chronicler" satisfies LoreSource, version: { increment: 1 } }
      });
    } else {
      // Non-authoritative: create if absent, skip if already exists.
      // Single atomic statement — safe under concurrent player sessions.
      await this.prisma.loreEntry.upsert({
        where: { campaignId_entityName: { campaignId, entityName } },
        create: { campaignId, entityName, type, description, source: "chronicler" satisfies LoreSource, version: 1 },
        update: {}
      });
    }
  }
}
