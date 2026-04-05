import type { SkillSchema } from "@opendungeon/content-sdk";
import { createProviderFromEnv, type LlmProvider, type ChatMessage } from "@opendungeon/providers-llm";

export interface IntentPattern {
  /** Representative sample of the action text. */
  sample: string;
  /** Total occurrences found in the logs. */
  occurrences: number;
}

export interface SkillSuggestion {
  /** Human-readable description of the detected pattern. */
  pattern: string;
  /** Number of times this intent was observed. */
  occurrences: number;
  /** Ready-to-save SkillSchema — can be written directly to skills/*.json. */
  skill: SkillSchema;
}

export interface SkillSuggestionRuntimeOptions {
  provider?: LlmProvider;
  maxJsonRepairAttempts?: number;
}

const SYSTEM_PROMPT = [
  "You are an OpenDungeon game designer assistant.",
  "You are given a list of player actions that were not handled by any game mechanic —",
  "the AI dungeon master narrated them freely without using a structured skill.",
  "",
  "Your task: identify recurring patterns and suggest new SkillSchema definitions",
  "that would make these interactions more structured and consistent.",
  "",
  "For each pattern decide the resolve mode:",
  '  "ai"            — open-ended actions where DM context matters (most actions)',
  '  "deterministic" — actions with a fixed, fully predictable outcome (use sparingly)',
  "",
  "A good SkillSchema includes:",
  '  - "id": short snake_case identifier',
  '  - "description": concise label shown to the DM as a tool (max 10 words)',
  '  - "dmPromptExtension": rules the DM should know about this skill (markdown)',
  '  - "resolve": "ai" | "deterministic"',
  '  - "outcome": required when resolve is "deterministic"',
  "",
  "Skip obvious one-offs. Focus on patterns that appear ≥2 times.",
  "",
  'Return strict JSON: { "suggestions": [ { "pattern": "...", "occurrences": N, "skill": { ...SkillSchema } } ] }'
].join("\n");

const JSON_REPAIR_PROMPT =
  "Your previous response was not valid JSON. Return only the JSON object, no markdown fences.";

export class SkillSuggestionRuntime {
  private readonly provider: LlmProvider;
  private readonly maxJsonRepairAttempts: number;

  constructor(options: SkillSuggestionRuntimeOptions = {}) {
    this.provider = options.provider ?? createProviderFromEnv();
    this.maxJsonRepairAttempts = options.maxJsonRepairAttempts ?? 2;
  }

  async suggestSkills(patterns: IntentPattern[]): Promise<SkillSuggestion[]> {
    if (patterns.length === 0) return [];

    const userMessage = JSON.stringify(
      {
        task: "Analyze these unhandled player intents and suggest SkillSchema definitions.",
        intents: patterns.map((p) => ({
          sample: p.sample,
          occurrences: p.occurrences
        }))
      },
      null,
      2
    );

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxJsonRepairAttempts; attempt++) {
      const response = await this.provider.createResponse({
        messages,
        temperature: 0.3,
        responseFormat: { type: "json_object" }
      });

      try {
        const parsed = parseResponse(response.text);
        return parsed;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxJsonRepairAttempts) {
          messages.push({ role: "assistant", content: response.text });
          messages.push({ role: "user", content: JSON_REPAIR_PROMPT });
        }
      }
    }

    throw new Error(`Skill suggestion failed after retries: ${String(lastError)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseResponse = (raw: string): SkillSuggestion[] => {
  const text = raw.startsWith("```") ? raw.split("\n").slice(1, -1).join("\n") : raw;
  const value = JSON.parse(text.trim());

  if (!value || typeof value !== "object" || !Array.isArray(value.suggestions)) {
    throw new Error('Response missing "suggestions" array');
  }

  return (value.suggestions as unknown[])
    .filter(isSuggestion)
    .map((s) => ({
      pattern: s.pattern,
      occurrences: s.occurrences,
      skill: s.skill
    }));
};

interface RawSuggestion {
  pattern: string;
  occurrences: number;
  skill: SkillSchema;
}

const isSuggestion = (v: unknown): v is RawSuggestion =>
  Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as Record<string, unknown>).pattern === "string" &&
      typeof (v as Record<string, unknown>).occurrences === "number" &&
      isSkillSchema((v as Record<string, unknown>).skill)
  );

const isSkillSchema = (v: unknown): v is SkillSchema =>
  Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as Record<string, unknown>).id === "string" &&
      typeof (v as Record<string, unknown>).description === "string" &&
      ((v as Record<string, unknown>).resolve === "ai" ||
        (v as Record<string, unknown>).resolve === "deterministic")
  );
