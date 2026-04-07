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
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface MechanicToolEntry {
  /** Routing key, e.g. "exploration.look" or "extraction.extract". */
  id: string;
  /** Human-readable description the DM uses to decide when to invoke this. */
  description: string;
  /** JSON Schema for the args the DM should pass, if any. */
  paramSchema?: Record<string, unknown>;
}

export interface DmTurnInput {
  campaignId: string;
  sessionId: string;
  campaignTitle: string;
  playerId: string;
  actionText: string;
  worldState: Record<string, unknown>;
  /** Player's current location - personal state, not shared across campaign */
  location: string;
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
  /**
   * Mechanic actions the DM can invoke instead of narrating freely.
   * When the DM emits `mechanicCall`, the engine routes to the named mechanic
   * action and uses its deterministic result instead of the DM's narrative.
   */
  availableMechanicActions?: MechanicToolEntry[];
}

export interface DmTurnResult {
  message: string;
  worldPatch?: Record<string, unknown>;
  /** Player's updated location - personal state, not shared across campaign */
  location?: string;
  summaryPatch?: DungeonMasterSummaryPatch;
  suggestedActions?: SuggestedAction[];
  /**
   * When set, the engine will execute this mechanic action instead of using
   * the DM's narrative response. The mechanic's ActionResult takes priority.
   */
  mechanicCall?: { id: string; args?: Record<string, unknown> };
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

const LLM_CONTEXT_LOG_FILE_ENV = "LLM_CONTEXT_LOG_FILE";
const DM_WORLD_STATE_MAX_BYTES_ENV = "DM_WORLD_STATE_MAX_BYTES";
const DM_WORLD_STATE_MAX_BYTES_DEFAULT = 2500;
const DM_RECENT_ACTIONS_MAX = 8;

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

    const hasMechanicTools =
      input.availableMechanicActions && input.availableMechanicActions.length > 0;

    const worldStateForPrompt = projectWorldStateForPrompt(input.worldState);
    const recentActionTexts = buildRecentActionTexts(input.recentEvents);

    const userPayload = {
      task: "Resolve one player action for a dungeon session.",
      ...(hasMechanicTools
        ? { availableMechanicActions: input.availableMechanicActions }
        : {}),
      responseContract: {
        message: "string (required)",
        ...(hasMechanicTools
          ? {
              mechanicCall: {
                id: "id from availableMechanicActions — invoke this mechanic instead of narrating freely (omit to narrate)",
                args: "optional object matching the action's paramSchema"
              }
            }
          : {}),
        toolCalls: [
          {
            tool: "update_world_state | set_summary | set_suggested_actions",
            args: "tool-specific object"
          }
        ],
        location: "string (optional) — player's new location if they moved",
        worldPatch: "object (optional, ignored when mechanicCall is set) — shared world facts only",
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
        location: input.location,
        summary: input.summary ?? "",
        contextualLore: input.contextualLore ?? "",
        worldState: worldStateForPrompt,
        recentActionTexts,
        recentActionsCount: recentActionTexts.length,
        totalRecentEventsSeen: input.recentEvents.length
      }
    };

    const userPayloadText = JSON.stringify(userPayload);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: userPayloadText
      }
    ];

    await writeContextSizeLog({
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      playerId: input.playerId,
      actionText: input.actionText,
      systemPrompt,
      summary: input.summary ?? "",
      contextualLore: input.contextualLore ?? "",
      worldStateRaw: input.worldState,
      worldStateForPrompt,
      recentEventsRaw: input.recentEvents,
      recentActionTexts,
      availableMechanicActions: hasMechanicTools ? input.availableMechanicActions ?? [] : [],
      userPayloadText,
      messages
    });

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

  // Extract location if provided
  if (typeof obj.location === "string" && obj.location.trim()) {
    result.location = obj.location.trim();
  }

  if (
    isRecord(obj.mechanicCall) &&
    typeof obj.mechanicCall.id === "string" &&
    obj.mechanicCall.id.trim()
  ) {
    result.mechanicCall = {
      id: obj.mechanicCall.id.trim(),
      args: isRecord(obj.mechanicCall.args) ? obj.mechanicCall.args : undefined
    };
  }

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

const toMetric = (label: string, value: string): { label: string; chars: number; bytes: number; tokens: number } => {
  const chars = value.length;
  const bytes = Buffer.byteLength(value, "utf8");
  const tokens = Math.ceil(bytes / 4);
  return { label, chars, bytes, tokens };
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const buildContextSizeLogBlock = (input: {
  campaignId: string;
  sessionId: string;
  playerId: string;
  actionText: string;
  systemPrompt: string;
  summary: string;
  contextualLore: string;
  worldStateRaw: Record<string, unknown>;
  worldStateForPrompt: Record<string, unknown>;
  recentEventsRaw: Array<{ createdAt: string; playerId: string; actionText: string; message: string }>;
  recentActionTexts: string[];
  availableMechanicActions: MechanicToolEntry[];
  userPayloadText: string;
  messages: ChatMessage[];
}): string => {
  const timestamp = new Date().toISOString();

  const sections = [
    toMetric("systemPrompt", input.systemPrompt),
    toMetric("summary", input.summary),
    toMetric("contextualLore", input.contextualLore),
    toMetric("worldStateRaw", safeStringify(input.worldStateRaw)),
    toMetric("worldStateForPrompt", safeStringify(input.worldStateForPrompt)),
    toMetric("recentEventsRaw", safeStringify(input.recentEventsRaw)),
    toMetric("recentActionTexts", safeStringify(input.recentActionTexts)),
    toMetric("availableMechanicActions", safeStringify(input.availableMechanicActions)),
    toMetric("userPayloadJson", input.userPayloadText),
    toMetric("messagesFull", safeStringify(input.messages))
  ];

  const totalBytes = sections.reduce((sum, s) => sum + s.bytes, 0);
  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);

  const actionPreview = input.actionText.length > 120
    ? `${input.actionText.slice(0, 120)}...`
    : input.actionText;

  const lines: string[] = [];
  lines.push("============================================================");
  lines.push(`[LLM_CONTEXT] ${timestamp}`);
  lines.push(`campaignId=${input.campaignId}`);
  lines.push(`sessionId=${input.sessionId}`);
  lines.push(`playerId=${input.playerId}`);
  lines.push(`actionText=${JSON.stringify(actionPreview)}`);
  lines.push("--- parts ---");

  for (const section of sections) {
    const percent = totalBytes > 0 ? ((section.bytes / totalBytes) * 100).toFixed(1) : "0.0";
    lines.push(
      `${section.label.padEnd(24)} chars=${String(section.chars).padStart(6)} bytes=${String(section.bytes).padStart(6)} est_tokens=${String(section.tokens).padStart(6)} share=${percent}%`
    );
  }

  lines.push("--- total ---");
  lines.push(`bytes=${totalBytes} est_tokens=${totalTokens}`);
  lines.push("============================================================");
  lines.push("");

  return lines.join("\n");
};

const writeContextSizeLog = async (input: {
  campaignId: string;
  sessionId: string;
  playerId: string;
  actionText: string;
  systemPrompt: string;
  summary: string;
  contextualLore: string;
  worldStateRaw: Record<string, unknown>;
  worldStateForPrompt: Record<string, unknown>;
  recentEventsRaw: Array<{ createdAt: string; playerId: string; actionText: string; message: string }>;
  recentActionTexts: string[];
  availableMechanicActions: MechanicToolEntry[];
  userPayloadText: string;
  messages: ChatMessage[];
}): Promise<void> => {
  const filePath = process.env[LLM_CONTEXT_LOG_FILE_ENV];
  if (!filePath || !filePath.trim()) return;

  try {
    await mkdir(dirname(filePath), { recursive: true });
    const block = buildContextSizeLogBlock(input);
    await appendFile(filePath, block, "utf8");
  } catch (err) {
    console.warn(`[LLM_CONTEXT] Failed to write ${LLM_CONTEXT_LOG_FILE_ENV}:`, err);
  }
};

const getWorldStatePromptMaxBytes = (): number => {
  const raw = process.env[DM_WORLD_STATE_MAX_BYTES_ENV];
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 200) {
    return Math.floor(parsed);
  }
  return DM_WORLD_STATE_MAX_BYTES_DEFAULT;
};

const keyPriority = (key: string): number => {
  // Note: key === "location" is no longer prioritized here as location is now
  // a separate field in DmTurnInput/DmTurnResult, not part of worldState.
  if (key.startsWith("location.")) return 1;
  if (key.includes("summary") || key.includes("beat")) return 2;
  if (key.includes("hp") || key.includes("health") || key.includes("gold")) return 3;
  if (key.includes("inventory") || key.includes("loot")) return 4;
  return 5;
};

const projectWorldStateForPrompt = (
  worldState: Record<string, unknown>
): Record<string, unknown> => {
  const maxBytes = getWorldStatePromptMaxBytes();
  const raw = safeStringify(worldState);
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes <= maxBytes) {
    return worldState;
  }

  const entries = Object.entries(worldState).sort((a, b) => {
    const prioDiff = keyPriority(a[0]) - keyPriority(b[0]);
    if (prioDiff !== 0) return prioDiff;
    return a[0].localeCompare(b[0]);
  });

  const selected: Record<string, unknown> = {};
  let omitted = 0;

  for (const [key, value] of entries) {
    const next = { ...selected, [key]: value };
    const bytes = Buffer.byteLength(safeStringify(next), "utf8");
    if (bytes <= maxBytes) {
      selected[key] = value;
    } else {
      omitted += 1;
    }
  }

  const withMeta: Record<string, unknown> = {
    ...selected,
    _contextTruncated: true,
    _contextMaxBytes: maxBytes,
    _contextRawBytes: rawBytes,
    _contextOmittedKeys: omitted
  };

  const finalBytes = Buffer.byteLength(safeStringify(withMeta), "utf8");
  if (finalBytes <= maxBytes) {
    return withMeta;
  }

  return {
    _contextTruncated: true,
    _contextMaxBytes: maxBytes,
    _contextRawBytes: rawBytes,
    _contextOmittedKeys: omitted
  };
};

const buildRecentActionTexts = (
  recentEvents: Array<{ actionText: string }>
): string[] => {
  return recentEvents
    .slice(-DM_RECENT_ACTIONS_MAX)
    .map((event) => event.actionText)
    .filter((text) => typeof text === "string" && text.trim().length > 0);
};
