/**
 * Game Scaffolder — generates declarative game module files from descriptions
 * or migrates existing TypeScript configs to JSON equivalents.
 *
 * Used by `od architect scaffold` to help game developers:
 * - Generate classes.json from a natural language description
 * - Migrate src/content/classes.ts → classes.json
 * - Migrate src/content/dm-config.ts → dm.md + dm-config.json
 * - Generate initial-state.json based on the setting
 * - Generate hooks/*.json for common patterns
 */

import { createProviderFromEnv, type LlmProvider, type ChatMessage } from "@opendungeon/providers-llm";

export interface ScaffoldInput {
  /** Absolute path to the existing module (for context). */
  modulePath: string;
  /** Target files to generate or migrate. */
  targetFiles: Array<"classes" | "dm" | "initial-state">;
  /** Raw content of setting.json if it exists (for context). */
  settingJsonContent?: string;
  /** Raw content of src/content/classes.ts to migrate (if migrating). */
  existingClassesTs?: string;
  /** Raw content of src/content/dm-config.ts to migrate (if migrating). */
  existingDmConfigTs?: string;
  /** Optional additional context or instructions from the developer. */
  developerInstructions?: string;
}

export interface ScaffoldFile {
  /** Relative path within the module directory (e.g. "classes.json", "hooks/starting-gear.json"). */
  relativePath: string;
  /** File contents to write. */
  content: string;
}

export interface ScaffoldOutput {
  files: ScaffoldFile[];
  warnings: string[];
}

export interface GameScaffolderRuntimeOptions {
  provider?: LlmProvider;
  maxJsonRepairAttempts?: number;
}

const CLASSES_FORMAT_SPEC = `
## classes.json format

\`\`\`json
{
  "classes": [
    {
      "name": "ClassName",
      "level": 1,
      "hp": 100,
      "attributes": { "strength": 10, "agility": 10 },
      "isDefault": true
    }
  ]
}
\`\`\`

Rules:
- "name": human-readable class name (PascalCase recommended)
- "level": starting level (integer ≥ 1)
- "hp": starting hit points (integer ≥ 1)
- "attributes": optional key-value map of stat names to numbers
- "isDefault": optional, mark ONE class as the fallback for unknown class names
`.trim();

const DM_FORMAT_SPEC = `
## dm.md format (DM system prompt)
Plain Markdown. The entire file becomes the DM's system prompt.
Keep it concise — 10-30 lines. Include:
- Tone and atmosphere guidelines
- Output format instructions (JSON with required "message" key)
- Critical gameplay rules

## dm-config.json format
\`\`\`json
{
  "toolPolicy": {
    "allowedTools": ["update_world_state", "set_summary", "set_suggested_actions"],
    "requireSummary": true,
    "requireSuggestedActions": true
  },
  "guardrails": {
    "maxSuggestedActions": 4,
    "maxSummaryChars": 220
  },
  "defaultSuggestedActions": [
    { "id": "look", "label": "Look Around", "prompt": "look around carefully" }
  ]
}
\`\`\`

Note: "systemPrompt" field in dm-config.json is supported but dm.md is preferred
for longer prompts. "suggestedActionStrategy" (a TypeScript function) cannot be
expressed in JSON — if the existing code uses it, note it in warnings.
`.trim();

const INITIAL_STATE_FORMAT_SPEC = `
## initial-state.json format
A flat JSON object with the starting worldState for new campaigns.
\`\`\`json
{
  "location": "start",
  "questStarted": false
}
\`\`\`
Rules:
- Use simple key-value pairs (strings, numbers, booleans, arrays)
- Keys should be camelCase
- This is the SHARED world state (all players see it)
- Per-character state (inventory, HP) is set in hooks/onCharacterCreated
`.trim();

const SYSTEM_PROMPT = [
  "You are an OpenDungeon game module file generator.",
  "Your job is to generate or migrate declarative game module files (JSON + Markdown).",
  "You follow exact schema specifications and produce valid, well-structured output.",
  "",
  "Output format:",
  "Return a JSON object: { \"files\": [ { \"relativePath\": \"...\", \"content\": \"...\" } ], \"warnings\": [ \"...\" ] }",
  "- relativePath: path relative to the module root (e.g. \"classes.json\")",
  "- content: the exact file contents as a string",
  "- warnings: any issues the developer should know about (non-fatal)",
  "",
  "Rules:",
  "- Return ONLY the JSON object, no markdown fences, no explanation",
  "- Preserve existing class names/stats exactly when migrating",
  "- When generating from scratch, use the setting.json context for thematic naming",
  "- Be generous with warnings for features that cannot be expressed in JSON",
  "",
  CLASSES_FORMAT_SPEC,
  "",
  DM_FORMAT_SPEC,
  "",
  INITIAL_STATE_FORMAT_SPEC
].join("\n");

const JSON_REPAIR_PROMPT =
  "Your previous response was not valid JSON. Return only the JSON object, no markdown fences.";

export class GameScaffolderRuntime {
  private readonly provider: LlmProvider;
  private readonly maxJsonRepairAttempts: number;

  constructor(options: GameScaffolderRuntimeOptions = {}) {
    this.provider = options.provider ?? createProviderFromEnv();
    this.maxJsonRepairAttempts = options.maxJsonRepairAttempts ?? 2;
  }

  async scaffold(input: ScaffoldInput): Promise<ScaffoldOutput> {
    const userContent = this.buildUserMessage(input);

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxJsonRepairAttempts; attempt++) {
      const response = await this.provider.createResponse({
        messages,
        temperature: attempt === 0 ? 0.2 : 0,
        responseFormat: { type: "json_object" }
      });

      try {
        const parsed = JSON.parse(response.text.trim()) as unknown;
        return this.validateOutput(parsed);
      } catch (err) {
        lastError = err;
        if (attempt < this.maxJsonRepairAttempts) {
          messages.push({ role: "assistant", content: response.text });
          messages.push({ role: "user", content: JSON_REPAIR_PROMPT });
        }
      }
    }

    throw new Error(
      `Scaffold LLM returned invalid JSON after ${this.maxJsonRepairAttempts} repair attempts: ${String(lastError)}`
    );
  }

  private buildUserMessage(input: ScaffoldInput): string {
    const parts: string[] = [];

    if (input.settingJsonContent) {
      parts.push(`## setting.json context\n\`\`\`json\n${input.settingJsonContent}\n\`\`\``);
    }

    if (input.existingClassesTs) {
      parts.push(
        `## Existing classes.ts to migrate\n\`\`\`typescript\n${input.existingClassesTs}\n\`\`\``
      );
    }

    if (input.existingDmConfigTs) {
      parts.push(
        `## Existing dm-config.ts to migrate\n\`\`\`typescript\n${input.existingDmConfigTs}\n\`\`\``
      );
    }

    if (input.developerInstructions) {
      parts.push(`## Developer instructions\n${input.developerInstructions}`);
    }

    const targetDesc = input.targetFiles.join(", ");
    parts.push(`## Task\nGenerate the following declarative files: ${targetDesc}`);

    if (input.existingClassesTs || input.existingDmConfigTs) {
      parts.push("Migrate the provided TypeScript files to their JSON equivalents. Preserve all values exactly.");
    } else {
      parts.push("Generate sensible defaults based on the setting context.");
    }

    return parts.join("\n\n");
  }

  private validateOutput(parsed: unknown): ScaffoldOutput {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object");
    }

    const obj = parsed as Record<string, unknown>;
    const files: ScaffoldFile[] = [];
    const warnings: string[] = [];

    if (Array.isArray(obj.files)) {
      for (const item of obj.files) {
        if (
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).relativePath === "string" &&
          typeof (item as Record<string, unknown>).content === "string"
        ) {
          files.push(item as ScaffoldFile);
        }
      }
    }

    if (Array.isArray(obj.warnings)) {
      for (const w of obj.warnings) {
        if (typeof w === "string") warnings.push(w);
      }
    }

    return { files, warnings };
  }
}
