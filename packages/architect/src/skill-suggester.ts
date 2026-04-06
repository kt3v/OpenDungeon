import { createProviderFromEnv, type LlmProvider, type ChatMessage } from "@opendungeon/providers-llm";

export interface IntentPattern {
  /** Representative sample of the action text. */
  sample: string;
  /** Total occurrences found in the logs. */
  occurrences: number;
}

export interface ModuleSuggestion {
  /** Human-readable description of the detected pattern. */
  pattern: string;
  /** Number of times this intent was observed. */
  occurrences: number;
  /** Suggested filename relative to module root, e.g. "modules/stealth.md" */
  path: string;
  /** Ready-to-save Markdown content with YAML frontmatter. */
  content: string;
}

export interface ModuleSuggestionRuntimeOptions {
  provider?: LlmProvider;
  maxJsonRepairAttempts?: number;
}

const SYSTEM_PROMPT = [
  "You are an OpenDungeon game designer assistant.",
  "You are given a list of player actions that were not handled by any structured game mechanic —",
  "the AI dungeon master narrated them freely without guidance from a context module.",
  "",
  "Your task: identify recurring patterns and suggest new context module files",
  "that would give the DM better guidance for these situations.",
  "",
  "A context module is a Markdown file in modules/ with optional YAML frontmatter.",
  "The module body is clear instructions to the DM — what worldPatch keys to set,",
  "what narrative outcomes look like, how to handle edge cases.",
  "",
  "For each pattern, produce a ready-to-save .md file with this structure:",
  "  ---",
  "  id: <kebab-case-id>",
  "  priority: <50-100>",
  "  alwaysInclude: false",
  "  triggers:",
  "    - <keyword1>",
  "    - <keyword2>",
  "  ---",
  "",
  "  ## <Mechanic Name>",
  "",
  "  - <Clear instruction to the DM>",
  "  - <What worldPatch keys to set and when>",
  "  - <Success/failure outcomes>",
  "",
  "Guidelines:",
  "  - triggers: short, common keywords a player would use (2-6 triggers)",
  "  - priority: 70-90 for important mechanics, 50-70 for situational ones",
  "  - alwaysInclude: true only for rules that must apply every turn (rare)",
  "  - module body: concrete DM instructions, not vague advice",
  "  - reference specific worldPatch keys the DM should set",
  "  - Skip obvious one-offs. Focus on patterns that appear ≥2 times.",
  "",
  'Return strict JSON: { "suggestions": [ { "pattern": "...", "occurrences": N, "path": "modules/<id>.md", "content": "<full markdown>" } ] }'
].join("\n");

const JSON_REPAIR_PROMPT =
  "Your previous response was not valid JSON. Return only the JSON object, no markdown fences.";

export class SkillSuggestionRuntime {
  private readonly provider: LlmProvider;
  private readonly maxJsonRepairAttempts: number;

  constructor(options: ModuleSuggestionRuntimeOptions = {}) {
    this.provider = options.provider ?? createProviderFromEnv();
    this.maxJsonRepairAttempts = options.maxJsonRepairAttempts ?? 2;
  }

  async suggestSkills(patterns: IntentPattern[]): Promise<ModuleSuggestion[]> {
    if (patterns.length === 0) return [];

    const userMessage = JSON.stringify(
      {
        task: "Analyze these unhandled player intents and suggest context module files.",
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

    throw new Error(`Module suggestion failed after retries: ${String(lastError)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseResponse = (raw: string): ModuleSuggestion[] => {
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
      path: s.path,
      content: s.content
    }));
};

interface RawSuggestion {
  pattern: string;
  occurrences: number;
  path: string;
  content: string;
}

const isSuggestion = (v: unknown): v is RawSuggestion =>
  Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as Record<string, unknown>).pattern === "string" &&
      typeof (v as Record<string, unknown>).occurrences === "number" &&
      typeof (v as Record<string, unknown>).path === "string" &&
      typeof (v as Record<string, unknown>).content === "string"
  );
