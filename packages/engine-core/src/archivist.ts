import type { ActionResult, DungeonMasterSummaryPatch } from "@opendungeon/content-sdk";
import {
  sanitizeDungeonMasterSummaryPatch,
  sanitizeDungeonMasterWorldPatch
} from "@opendungeon/content-sdk";
import { type LlmProvider } from "@opendungeon/providers-llm";

export interface ArchivistTurnInput {
  actionText: string;
  worldState: Record<string, unknown>;
  dmResult: ActionResult;
}

export interface ArchivistTurnResult {
  worldPatch?: Record<string, unknown>;
  summaryPatch?: DungeonMasterSummaryPatch;
}

export class ArchivistRuntime {
  constructor(private readonly provider: LlmProvider) {}

  async runTurn(input: ArchivistTurnInput): Promise<ArchivistTurnResult> {
    const startTime = Date.now();
    const logPrefix = `[Archivist ${new Date().toISOString()}]`;

    console.log(`${logPrefix} Starting archivist processing`);

    try {
      const response = await this.provider.createResponse({
        temperature: 0,
        responseFormat: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are Archivist for a multiplayer RPG world state.",
              "Your role is to normalize state updates and concise session summaries.",
              "Return strict JSON only in shape:",
              '{"worldPatch": Record<string, unknown>, "summaryPatch": {"shortSummary"?: string, "latestBeat"?: string}}',
              "Do not invent major world changes not implied by the DM result."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              actionText: input.actionText,
              worldState: input.worldState,
              dmResult: {
                message: input.dmResult.message,
                worldPatch: input.dmResult.worldPatch,
                summaryPatch: input.dmResult.summaryPatch
              }
            })
          }
        ]
      });

      const duration = Date.now() - startTime;
      console.log(`${logPrefix} Completed in ${duration}ms`);

      return parseArchivistResult(response.text);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.warn(`${logPrefix} Failed after ${duration}ms:`, error instanceof Error ? error.message : error);
      return {}; // Return empty result on failure - don't block the turn
    }
  }
}

const parseArchivistResult = (raw: string): ArchivistTurnResult => {
  const normalized = stripCodeFence(raw).trim();

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const obj = parsed as Record<string, unknown>;
    const worldPatch = sanitizeDungeonMasterWorldPatch(obj.worldPatch);
    const summaryPatch = sanitizeDungeonMasterSummaryPatch(obj.summaryPatch);

    return {
      ...(Object.keys(worldPatch).length > 0 ? { worldPatch } : {}),
      ...(summaryPatch ? { summaryPatch } : {})
    };
  } catch {
    return {};
  }
};

const stripCodeFence = (value: string): string => {
  if (value.startsWith("```") && value.endsWith("```")) {
    const lines = value.split("\n");
    return lines.slice(1, -1).join("\n");
  }

  return value;
};
