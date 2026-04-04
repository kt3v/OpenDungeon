import type { LlmProvider } from "@opendungeon/providers-llm";
import type { RecentEvent } from "./index.js";

const COMPRESSOR_SYSTEM_PROMPT = `
You are a chronicler for a roleplaying game. 
Your task is to take a transcript of recent session events and summarize them into a single, cohesive narrative paragraph.
Exclude raw game mechanics and focus purely on the story that transpired.
Return plain text only, no formatting, no JSON.
`.trim();

/**
 * Compresses a list of recent events into a narrative summary string.
 */
export async function compressSessionHistory(
  provider: LlmProvider,
  events: RecentEvent[]
): Promise<string> {
  if (events.length === 0) return "";

  const transcript = events
    .map((e) => `Player: ${e.actionText}\nDM: ${e.message}`)
    .join("\n\n");

  try {
    const response = await provider.createResponse({
      messages: [
        { role: "system", content: COMPRESSOR_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Transcript to summarize:\n${transcript}`,
        },
      ],
      temperature: 0.3,
    });

    return response.text.trim();
  } catch (error) {
    console.warn("Event compression failed:", error);
    return "";
  }
}
