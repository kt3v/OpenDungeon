import { PrismaClient } from "@prisma/client";
import { ArchitectRuntime, ArchitectOperationExecutor } from "@opendungeon/architect";
import type { ChatRequest, ChatResponse, LlmProvider } from "@opendungeon/providers-llm";

class FixedChroniclerProvider implements LlmProvider {
  name = "fixed-chronicler";
  model = "fixed-v1";

  async createResponse(_request: ChatRequest): Promise<ChatResponse> {
    return {
      provider: this.name,
      model: this.model,
      text: JSON.stringify({
        operations: [
          {
            op: "set_world_fact",
            key: "merchant.reputation",
            value: 12,
            sourceTag: "chronicler"
          },
          {
            op: "upsert_lore",
            entityName: "Borin the Merchant",
            type: "NPC",
            description: "A cautious merchant whose trust grows after fair deals.",
            authoritative: false
          },
          {
            op: "append_session_archive",
            sessionId: "session-e2e",
            text: "The player negotiated a trade and improved their standing with Borin."
          }
        ]
      })
    };
  }
}

const run = async (): Promise<void> => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for mvp:chronicler-check");
  }

  const prisma = new PrismaClient();
  const runtime = new ArchitectRuntime({ provider: new FixedChroniclerProvider() });
  const executor = new ArchitectOperationExecutor(prisma);

  const email = `chronicler-${Date.now()}@opendungeon.dev`;

  try {
    const user = await prisma.user.create({
      data: {
        email,
        password: "dev-only-password",
        displayName: "Chronicler E2E"
      }
    });

    const campaign = await prisma.campaign.create({
      data: {
        tenantId: user.id,
        title: "Chronicler E2E Campaign",
        moduleName: "@opendungeon/game-example",
        moduleVersion: "0.1.2"
      }
    });

    await prisma.campaignMember.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        role: "owner"
      }
    });

    const session = await prisma.session.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        characterName: "E2E Tester",
        characterClass: "Rogue",
        startedAt: new Date(),
        status: "active"
      }
    });

    const result = await runtime.runChronicler({
      campaignId: campaign.id,
      sessionId: session.id,
      recentEvents: [
        {
          id: "evt-1",
          createdAt: new Date().toISOString(),
          playerId: user.id,
          actionText: "I negotiate with Borin for lower prices.",
          message: "Borin nods and agrees to better terms."
        }
      ],
      existingLore: [],
      currentWorldState: {}
    });

    await executor.execute(result.operations, campaign.id);

    const worldFact = await prisma.worldFact.findUnique({
      where: { campaignId_key: { campaignId: campaign.id, key: "merchant.reputation" } }
    });
    if (!worldFact || worldFact.value !== 12) {
      throw new Error("Expected world fact merchant.reputation=12 to be written by chronicler pipeline");
    }

    const lore = await prisma.loreEntry.findUnique({
      where: { campaignId_entityName: { campaignId: campaign.id, entityName: "Borin the Merchant" } }
    });
    if (!lore) {
      throw new Error("Expected lore entry to be written by chronicler pipeline");
    }

    const updatedSession = await prisma.session.findUnique({ where: { id: session.id }, select: { archive: true } });
    if (!updatedSession?.archive?.includes("negotiated a trade")) {
      throw new Error("Expected session archive to be updated by chronicler pipeline");
    }

    process.stdout.write("Chronicler e2e check passed: operations persisted worldFact, lore, and archive\n");
  } finally {
    await prisma.$disconnect();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`Chronicler e2e check failed: ${String(error)}\n`);
  process.exit(1);
});
