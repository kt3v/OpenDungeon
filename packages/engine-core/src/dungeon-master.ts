import {
  normalizeDungeonMasterToolCalls,
  renderDungeonMasterPromptTemplate,
  sanitizeDungeonMasterSuggestedActions,
  sanitizeDungeonMasterSummaryPatch,
  sanitizeDungeonMasterWorldPatch,
  type DungeonMasterGuardrails,
  type DungeonMasterModuleConfig,
  type DungeonMasterSummaryPatch,
  type DungeonMasterToolPolicy,
  type SuggestedAction
} from "@opendungeon/content-sdk";
import { createProviderFromEnv, type ChatMessage, type LlmProvider } from "@opendungeon/providers-llm";

export interface DmTurnInput {
  campaignId: string;
  sessionId: string;
  campaignTitle: string;
  playerId: string;
  actionText: string;
  worldState: Record<string, unknown>;
  recentEvents: Array<{
    createdAt: string;
    playerId: string;
    actionText: string;
    message: string;
  }>;
  summary?: string;
  contextualLore?: string;
  lastSuggestedActions?: SuggestedAction[];
  moduleConfig?: DungeonMasterModuleConfig;
}

export interface DmTurnResult {
  message: string;
  worldPatch?: Record<string, unknown>;
  summaryPatch?: DungeonMasterSummaryPatch;
  suggestedActions?: SuggestedAction[];
}

export interface DungeonMasterRuntimeOptions {
  provider?: LlmProvider;
  systemPrompt?: string;
  maxJsonRepairAttempts?: number;
  guardrails?: Partial<DungeonMasterGuardrails>;
  moduleConfig?: DungeonMasterModuleConfig;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a runtime fallback prompt for OpenDungeon.",
  "Return strict JSON only with a non-empty message field.",
  "Do not include markdown code fences or commentary."
].join("\n");

export class DungeonMasterRuntime {
  private readonly provider: LlmProvider;
  private readonly systemPrompt: string;
  private readonly maxJsonRepairAttempts: number;
  private readonly guardrails?: Partial<DungeonMasterGuardrails>;
  private readonly moduleConfig?: DungeonMasterModuleConfig;

  constructor(options: DungeonMasterRuntimeOptions = {}) {
    this.provider = options.provider ?? createProviderFromEnv();
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxJsonRepairAttempts = options.maxJsonRepairAttempts ?? 2;
    this.guardrails = options.guardrails;
    this.moduleConfig = options.moduleConfig;
  }

  async runTurn(input: DmTurnInput): Promise<DmTurnResult> {
    const moduleConfig = input.moduleConfig ?? this.moduleConfig;
    const resolvedGuardrails = moduleConfig?.guardrails ?? this.guardrails;
    const toolPolicy = moduleConfig?.toolPolicy;
    const defaultSuggestedActions =
      moduleConfig?.suggestedActionStrategy?.({
        state: input.worldState,
        summary: input.summary,
        lastSuggestedActions: input.lastSuggestedActions
      }) ?? moduleConfig?.defaultSuggestedActions;

    const systemPrompt = resolveSystemPrompt({
      fallbackPrompt: this.systemPrompt,
      moduleConfig,
      promptContext: { campaignTitle: input.campaignTitle }
    });

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Resolve one player action for a dungeon session.",
            responseContract: {
              message: "string (required)",
              toolCalls: [
                {
                  tool: "update_world_state | set_summary | set_suggested_actions",
                  args: "tool-specific object"
                }
              ],
              worldPatch: "object (optional)",
              summaryPatch: {
                shortSummary: "string (optional)",
                latestBeat: "string (optional)"
              },
              suggestedActions: [{ id: "string", label: "string", prompt: "string" }]
            },
            context: {
              campaignId: input.campaignId,
              sessionId: input.sessionId,
              campaignTitle: input.campaignTitle,
              playerId: input.playerId,
              actionText: input.actionText,
              summary: input.summary ?? "",
              contextualLore: input.contextualLore ?? "",
              worldState: input.worldState,
              recentEvents: input.recentEvents.slice(-20)
            }
          },
          null,
          2
        )
      }
    ];

    let lastParseError: unknown;
    for (let attempt = 0; attempt <= this.maxJsonRepairAttempts; attempt += 1) {
      const response = await this.provider.createResponse({
        messages,
        temperature: 0.4,
        responseFormat: { type: "json_object" }
      });

      try {
        const parsed = parseDmResult(response.text, {
          guardrails: resolvedGuardrails,
          fallbackSummary: input.summary,
          fallbackMessage: input.actionText,
          toolPolicy,
          defaultSuggestedActions
        });
        return parsed;
      } catch (error) {
        lastParseError = error;

        if (attempt >= this.maxJsonRepairAttempts) {
          break;
        }

        messages.push({ role: "assistant", content: response.text });
        messages.push({ role: "user", content: JSON_REPAIR_PROMPT });
      }
    }

    throw new Error(`DM response parsing failed after retries: ${String(lastParseError)}`);
  }
}

const JSON_REPAIR_PROMPT = [
  "Your previous response was invalid for the required JSON contract.",
  "Return valid JSON only.",
  "Do not include markdown fences or commentary.",
  "Make sure 'message' is a non-empty string."
].join(" ");

const parseDmResult = (
  rawText: string,
  options: {
    guardrails?: Partial<DungeonMasterGuardrails>;
    fallbackSummary?: string;
    fallbackMessage?: string;
    toolPolicy?: DungeonMasterToolPolicy;
    defaultSuggestedActions?: SuggestedAction[];
  } = {}
): DmTurnResult => {
  const normalized = stripCodeFence(rawText).trim();
  let value: unknown;

  try {
    value = JSON.parse(normalized);
  } catch {
    throw new Error("DM response is not valid JSON");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DM response must be a JSON object");
  }

  const obj = value as Record<string, unknown>;
  const message = obj.message;
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("DM response missing required 'message' string");
  }

  const result: DmTurnResult = {
    message: message.trim()
  };

  const toolCalls = normalizeDungeonMasterToolCalls(obj.toolCalls, {
    guardrails: options.guardrails,
    fallbackSummary: options.fallbackSummary,
    toolPolicy: options.toolPolicy
  });
  if (toolCalls.length > 0) {
    applyToolCalls(result, toolCalls, {
      guardrails: options.guardrails,
      defaultSuggestedActions: options.defaultSuggestedActions
    });
  }

  const worldPatch = sanitizeDungeonMasterWorldPatch(obj.worldPatch, {
    guardrails: options.guardrails
  });
  if (Object.keys(worldPatch).length > 0) {
    result.worldPatch = worldPatch;
  }

  const summaryPatch = sanitizeDungeonMasterSummaryPatch(obj.summaryPatch, {
    guardrails: options.guardrails,
    fallbackSummary: options.fallbackSummary
  });
  if (summaryPatch) {
    result.summaryPatch = summaryPatch;
  }

  const suggestedActions = sanitizeDungeonMasterSuggestedActions(obj.suggestedActions, {
    guardrails: options.guardrails,
    defaultActions: options.defaultSuggestedActions
  });
  if (suggestedActions.length > 0) {
    result.suggestedActions = suggestedActions;
  }

  if (!result.summaryPatch) {
    result.summaryPatch = sanitizeDungeonMasterSummaryPatch(undefined, {
      guardrails: options.guardrails,
      fallbackSummary: options.fallbackSummary
    });
  }

  if (!result.suggestedActions) {
    result.suggestedActions = sanitizeDungeonMasterSuggestedActions(undefined, {
      guardrails: options.guardrails,
      ensureAtLeastOne: true,
      defaultActions: options.defaultSuggestedActions
    });
  }

  if (!result.message.trim()) {
    result.message = options.fallbackMessage?.trim() || "You pause and reassess your next move.";
  }

  return result;
};

const applyToolCalls = (
  result: DmTurnResult,
  toolCalls: ReturnType<typeof normalizeDungeonMasterToolCalls>,
  options: {
    guardrails?: Partial<DungeonMasterGuardrails>;
    defaultSuggestedActions?: SuggestedAction[];
  } = {}
): void => {
  for (const call of toolCalls) {
    if (call.tool === "update_world_state") {
      const merged = {
        ...(result.worldPatch ?? {}),
        ...call.args.patch
      };
      const sanitized = sanitizeDungeonMasterWorldPatch(merged, { guardrails: options.guardrails });
      if (Object.keys(sanitized).length > 0) {
        result.worldPatch = sanitized;
      }
      continue;
    }

    if (call.tool === "set_summary") {
      result.summaryPatch = sanitizeDungeonMasterSummaryPatch(call.args, {
        guardrails: options.guardrails,
        fallbackSummary: result.summaryPatch?.shortSummary
      });
      continue;
    }

    result.suggestedActions = sanitizeDungeonMasterSuggestedActions(call.args.actions, {
      guardrails: options.guardrails,
      ensureAtLeastOne: true,
      defaultActions: options.defaultSuggestedActions
    });
  }
};

const stripCodeFence = (value: string): string => {
  if (value.startsWith("```") && value.endsWith("```")) {
    const lines = value.split("\n");
    return lines.slice(1, -1).join("\n");
  }
  return value;
};

const resolveSystemPrompt = (input: {
  fallbackPrompt: string;
  moduleConfig?: DungeonMasterModuleConfig;
  promptContext?: { campaignTitle?: string };
}): string => {
  if (!input.moduleConfig) {
    return input.fallbackPrompt;
  }

  if (input.moduleConfig.promptTemplate) {
    return renderDungeonMasterPromptTemplate(input.moduleConfig.promptTemplate, input.promptContext);
  }

  if (input.moduleConfig.systemPrompt) {
    return input.moduleConfig.systemPrompt;
  }

  return input.fallbackPrompt;
};
