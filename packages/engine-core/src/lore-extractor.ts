import { stripCodeFence } from "@opendungeon/shared";
import type { LlmProvider } from "@opendungeon/providers-llm";

export interface LoreEntryPayload {
  entityName: string;
  type: string;
  description: string;
}

const EXTRACTOR_SYSTEM_PROMPT = `
You are a background entity extractor for a roleplaying game.
Your job is to read the latest player action and the Dungeon Master's response, and extract ANY newly established world facts, NPCs, items, or locations.
Ignore transient actions (e.g. "I hit the goblin"). Focus on permanent world facts (e.g. "The Barkeep is named Bob", "There is a cursed sword in the chest", "The town is called Oakhaven").

Return strict JSON only matching this schema:
{
  "entities": [
    {
      "entityName": "string",
      "type": "NPC" | "Location" | "Item" | "Faction" | "Lore",
      "description": "string (concise summary of the fact)"
    }
  ]
}
`.trim();

/**
 * Parses the interaction text and returns extracted lore entities.
 */
export async function extractLore(
  provider: LlmProvider,
  actionText: string,
  dmMessage: string
): Promise<LoreEntryPayload[]> {
  try {
    const response = await provider.createResponse({
      messages: [
        { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Player action:\n${actionText}\n\nDM response:\n${dmMessage}`,
        },
      ],
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    });

    const text = stripCodeFence(response.text).trim();
    const parsed = JSON.parse(text) as { entities?: LoreEntryPayload[] };
    return parsed.entities ?? [];
  } catch (error) {
    console.warn("Lore extraction failed:", error);
    return [];
  }
}
