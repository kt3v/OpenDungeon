import { createArchitectProviderFromEnv, type ChatMessage, type LlmProvider } from "@opendungeon/providers-llm";
import type { ArchitectOperation, LoreEntityType, MilestoneType } from "./operations.js";
import { CHRONICLER_SYSTEM_PROMPT } from "./prompts/chronicler.js";
import { WORLDBUILDER_SYSTEM_PROMPT } from "./prompts/worldbuilder.js";

// ---------------------------------------------------------------------------
// Chronicler types (Mode 2 — session background)
// ---------------------------------------------------------------------------

export interface ChroniclerEvent {
  id: string;
  createdAt: string;
  playerId: string;
  actionText: string;
  message: string;
}

export interface ChroniclerLoreEntry {
  entityName: string;
  type: string;
  description: string;
}

export interface ChroniclerInput {
  campaignId: string;
  sessionId: string;
  recentEvents: ChroniclerEvent[];
  existingLore: ChroniclerLoreEntry[];
  currentWorldState: Record<string, unknown>;
}

export interface ChroniclerResult {
  operations: ArchitectOperation[];
}

// ---------------------------------------------------------------------------
// Worldbuilder types (Mode 1 — developer CLI)
// ---------------------------------------------------------------------------

export interface WorldbuilderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WorldbuilderModuleContext {
  availableClasses: string[];
  existingWorldState: Record<string, unknown>;
  existingLore: ChroniclerLoreEntry[];
  /** Absolute path to the game module root directory (undefined = no module loaded) */
  modulePath?: string;
  /** Relative paths of existing game module files — modules/*.md, lore/*.md, indicators/*.json, etc. */
  existingFiles?: string[];
}

export interface WorldbuilderTurnInput {
  conversationHistory: WorldbuilderMessage[];
  userMessage: string;
  moduleContext: WorldbuilderModuleContext;
}

export interface WorldbuilderTurnResult {
  assistantMessage: string;
  pendingOperations: ArchitectOperation[];
  requiresConfirmation: boolean;
  /** Operations the LLM produced but that failed validation — for debug display */
  droppedOperationCount: number;
  /** Optional operation-level confidence metadata from the model reviewer pass */
  operationAssessments: WorldbuilderOperationAssessment[];
  /** Optional reviewer summary from second-pass critique */
  reviewerSummary?: string;
}

export interface WorldbuilderOperationAssessment {
  opIndex?: number;
  path?: string;
  confidence: "low" | "medium" | "high";
  rationale: string;
}

// ---------------------------------------------------------------------------
// ArchitectRuntime
// ---------------------------------------------------------------------------

export interface ArchitectRuntimeOptions {
  provider?: LlmProvider;
  /** Default temperature applied to both modes. Defaults to 0.1. */
  temperature?: number;
  maxJsonRepairAttempts?: number;
  /**
   * Maximum output tokens for LLM responses.
   * The Architect generates multiple complete JSON files per response, so this
   * must be high enough to avoid truncation. Defaults to 8192.
   */
  maxOutputTokens?: number;
}

export class ArchitectRuntime {
  private readonly provider: LlmProvider;
  private readonly temperature: number;
  private readonly maxJsonRepairAttempts: number;
  private readonly maxOutputTokens: number;

  constructor(options: ArchitectRuntimeOptions = {}) {
    this.provider = options.provider ?? createArchitectProviderFromEnv();
    this.temperature = options.temperature ?? 0.1;
    this.maxJsonRepairAttempts = options.maxJsonRepairAttempts ?? 2;
    this.maxOutputTokens = options.maxOutputTokens ?? 8192;
  }

  // ---------------------------------------------------------------------------
  // Mode 2 — Chronicler
  // ---------------------------------------------------------------------------

  async runChronicler(input: ChroniclerInput): Promise<ChroniclerResult> {
    const userContent = JSON.stringify(
      {
        task: "Analyze the session transcript and produce world-record operations.",
        sessionId: input.sessionId,
        campaignId: input.campaignId,
        recentEvents: input.recentEvents,
        existingLore: input.existingLore,
        currentWorldState: input.currentWorldState
      },
      null,
      2
    );

    const messages: ChatMessage[] = [
      { role: "system", content: CHRONICLER_SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ];

    const raw = await this.callWithRepair(messages, "Chronicler");
    return this.parseChroniclerResult(raw, input.sessionId);
  }

  private parseChroniclerResult(raw: string, sessionId: string): ChroniclerResult {
    const obj = parseJsonObject(raw);
    const rawOps = Array.isArray(obj.operations) ? (obj.operations as unknown[]) : [];
    const operations: ArchitectOperation[] = [];

    for (const item of rawOps) {
      const op = validateArchitectOperation(item, sessionId);
      if (op) operations.push(op);
    }

    return { operations };
  }

  // ---------------------------------------------------------------------------
  // Mode 1 — Worldbuilder
  // ---------------------------------------------------------------------------

  async runWorldbuilderTurn(input: WorldbuilderTurnInput): Promise<WorldbuilderTurnResult> {
    const ctx = input.moduleContext;
    const moduleSection = ctx.modulePath
      ? `Module root: ${ctx.modulePath}`
      : "Module root: (none — advisory mode, file operations unavailable)";

    const filesSection =
      ctx.existingFiles && ctx.existingFiles.length > 0
        ? `Existing module files:\n${ctx.existingFiles.map((f) => `  - ${f}`).join("\n")}`
        : "Existing module files: (none detected)";

    const systemWithContext = `${WORLDBUILDER_SYSTEM_PROMPT}

## Current Module Context

${moduleSection}

Available character classes: ${JSON.stringify(ctx.availableClasses)}

${filesSection}

Existing world state (${Object.keys(ctx.existingWorldState).length} facts):
${JSON.stringify(ctx.existingWorldState, null, 2)}

Existing lore entries (${ctx.existingLore.length} entities):
${JSON.stringify(ctx.existingLore, null, 2)}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemWithContext },
      ...input.conversationHistory,
      { role: "user", content: input.userMessage }
    ];

    const draftRaw = await this.callWithRepair(messages, "Worldbuilder");
    const reviewedRaw = await this.reviewWorldbuilderDraft({
      systemWithContext,
      userMessage: input.userMessage,
      draftRaw
    });
    return this.parseWorldbuilderResult(reviewedRaw);
  }

  private async reviewWorldbuilderDraft(input: {
    systemWithContext: string;
    userMessage: string;
    draftRaw: string;
  }): Promise<string> {
    let draftObj: Record<string, unknown>;
    try {
      draftObj = parseJsonObject(input.draftRaw);
    } catch {
      return input.draftRaw;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: WORLDBUILDER_REVIEWER_PROMPT },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Review and correct the candidate Worldbuilder output.",
            userMessage: input.userMessage,
            architectureContext: input.systemWithContext,
            candidate: draftObj
          },
          null,
          2
        )
      }
    ];

    try {
      const reviewedRaw = await this.callWithRepair(messages, "Worldbuilder Reviewer");
      const reviewedObj = parseJsonObject(reviewedRaw);
      if (!("message" in reviewedObj) && !("pendingOperations" in reviewedObj)) {
        return input.draftRaw;
      }
      return reviewedRaw;
    } catch {
      return input.draftRaw;
    }
  }

  private parseWorldbuilderResult(raw: string): WorldbuilderTurnResult {
    const obj = parseJsonObject(raw);

    const assistantMessage =
      typeof obj.message === "string" && obj.message.trim()
        ? obj.message.trim()
        : "I've processed your request.";

    const rawOps = Array.isArray(obj.pendingOperations) ? (obj.pendingOperations as unknown[]) : [];
    const pendingOperations: ArchitectOperation[] = [];
    let droppedOperationCount = 0;

    for (const item of rawOps) {
      const op = validateArchitectOperation(item, undefined);
      if (op) {
        pendingOperations.push(op);
      } else {
        droppedOperationCount++;
      }
    }

    const requiresConfirmation =
      typeof obj.requiresConfirmation === "boolean" ? obj.requiresConfirmation : pendingOperations.length > 0;

    const operationAssessments = parseOperationAssessments(obj.operationAssessments, pendingOperations.length);
    const reviewerSummary = typeof obj.reviewerSummary === "string" && obj.reviewerSummary.trim()
      ? obj.reviewerSummary.trim()
      : undefined;

    return {
      assistantMessage,
      pendingOperations,
      requiresConfirmation,
      droppedOperationCount,
      operationAssessments,
      reviewerSummary
    };
  }

  // ---------------------------------------------------------------------------
  // Shared LLM call with JSON repair loop
  // ---------------------------------------------------------------------------

  private async callWithRepair(messages: ChatMessage[], agentName: string): Promise<string> {
    let lastError: unknown;
    const localMessages = [...messages];

    for (let attempt = 0; attempt <= this.maxJsonRepairAttempts; attempt += 1) {
      const response = await this.provider.createResponse({
        messages: localMessages,
        temperature: this.temperature,
        maxTokens: this.maxOutputTokens,
        responseFormat: { type: "json_object" }
      });

      try {
        parseJsonObject(response.text);
        return response.text;
      } catch (err) {
        lastError = err;
        if (attempt >= this.maxJsonRepairAttempts) break;
        localMessages.push({ role: "assistant", content: response.text });
        localMessages.push({ role: "user", content: JSON_REPAIR_PROMPT });
      }
    }

    throw new Error(`${agentName} response parsing failed after retries: ${String(lastError)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JSON_REPAIR_PROMPT =
  "Your previous response was not valid JSON. Return valid JSON only. No markdown fences or commentary.";

const WORLDBUILDER_REVIEWER_PROMPT = `You are the Architect Output Reviewer for OpenDungeon.
Your job is to review a candidate Worldbuilder JSON response and return a corrected, safer version.

Rules:
- Preserve user intent and keep output concise.
- Enforce state-model consistency:
  - world references/provides should align with initial-state keys.
  - avoid nested world/character wrapper objects in initial-state unless explicitly required by project conventions.
  - keep character-state and world-state semantics consistent.
- Remove or fix malformed operations.
- Prefer minimal edits over large rewrites.

Return JSON object only with fields:
{
  "message": "string",
  "pendingOperations": [ ... ],
  "requiresConfirmation": true,
  "reviewerSummary": "optional short summary",
  "operationAssessments": [
    { "opIndex": 0, "path": "optional file path", "confidence": "low|medium|high", "rationale": "short reason" }
  ]
}`;

const WORLD_FACT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_WORLD_FACT_KEY_LENGTH = 120;

const parseJsonObject = (raw: string): Record<string, unknown> => {
  const normalized = stripCodeFence(raw).trim();
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new Error("Response is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Response must be a JSON object");
  }
  return value as Record<string, unknown>;
};

const stripCodeFence = (value: string): string => {
  if (value.startsWith("```") && value.endsWith("```")) {
    const lines = value.split("\n");
    return lines.slice(1, -1).join("\n");
  }
  return value;
};

const VALID_LORE_TYPES = new Set(["NPC", "Location", "Item", "Faction", "Lore"]);
const VALID_MILESTONE_TYPES = new Set(["boss_kill", "story_beat", "campaign_end", "custom"]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

const parseOperationAssessments = (
  value: unknown,
  pendingOperationCount: number
): WorldbuilderOperationAssessment[] => {
  if (!Array.isArray(value)) return [];
  const out: WorldbuilderOperationAssessment[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.confidence !== "string" || !VALID_CONFIDENCE.has(obj.confidence)) continue;
    if (typeof obj.rationale !== "string" || !obj.rationale.trim()) continue;

    const opIndex =
      typeof obj.opIndex === "number" && Number.isInteger(obj.opIndex) && obj.opIndex >= 0 && obj.opIndex < pendingOperationCount
        ? obj.opIndex
        : undefined;

    out.push({
      opIndex,
      path: typeof obj.path === "string" && obj.path.trim() ? obj.path.trim() : undefined,
      confidence: obj.confidence as "low" | "medium" | "high",
      rationale: obj.rationale.trim()
    });
  }

  return out;
};

const validateArchitectOperation = (item: unknown, sessionId: string | undefined): ArchitectOperation | null => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;

  switch (obj.op) {
    case "upsert_lore": {
      if (typeof obj.entityName !== "string" || !obj.entityName.trim()) return null;
      if (typeof obj.type !== "string" || !VALID_LORE_TYPES.has(obj.type)) return null;
      if (typeof obj.description !== "string" || !obj.description.trim()) return null;
      return {
        op: "upsert_lore",
        entityName: obj.entityName.trim(),
        type: obj.type as LoreEntityType,
        description: obj.description.trim(),
        authoritative: obj.authoritative === true
      };
    }

    case "set_world_fact": {
      if (typeof obj.key !== "string" || !obj.key.trim()) return null;
      const key = obj.key.trim();
      if (key.length > MAX_WORLD_FACT_KEY_LENGTH) return null;
      if (!WORLD_FACT_KEY_PATTERN.test(key)) return null;
      if (obj.value === undefined) return null;
      const sourceTag = obj.sourceTag === "developer" ? "developer" : "chronicler";
      return { op: "set_world_fact", key, value: obj.value, sourceTag };
    }

    case "append_session_archive": {
      const sid = typeof obj.sessionId === "string" ? obj.sessionId : (sessionId ?? "");
      if (!sid) return null;
      if (typeof obj.text !== "string" || !obj.text.trim()) return null;
      return { op: "append_session_archive", sessionId: sid, text: obj.text.trim() };
    }

    case "append_campaign_archive": {
      if (typeof obj.text !== "string" || !obj.text.trim()) return null;
      return { op: "append_campaign_archive", text: obj.text.trim() };
    }

    case "create_milestone": {
      if (typeof obj.title !== "string" || !obj.title.trim()) return null;
      if (typeof obj.description !== "string" || !obj.description.trim()) return null;
      if (typeof obj.milestoneType !== "string" || !VALID_MILESTONE_TYPES.has(obj.milestoneType)) return null;
      return {
        op: "create_milestone",
        title: obj.title.trim(),
        description: obj.description.trim(),
        milestoneType: obj.milestoneType as MilestoneType,
        sessionId: typeof obj.sessionId === "string" ? obj.sessionId : sessionId
      };
    }

    case "resolve_lore_conflict": {
      if (typeof obj.entityName !== "string" || !obj.entityName.trim()) return null;
      if (typeof obj.canonicalDescription !== "string" || !obj.canonicalDescription.trim()) return null;
      return {
        op: "resolve_lore_conflict",
        entityName: obj.entityName.trim(),
        canonicalDescription: obj.canonicalDescription.trim()
      };
    }

    case "write_file": {
      if (typeof obj.path !== "string" || !obj.path.trim()) return null;
      if (typeof obj.description !== "string") return null;
      // Basic safety: reject paths that try to escape the module root
      const p = obj.path.trim();
      if (p.startsWith("/") || p.includes("..")) return null;
      // LLMs sometimes return content as a parsed object instead of a JSON string.
      // Accept both: stringify objects, pass strings through as-is.
      let content: string;
      if (typeof obj.content === "string") {
        content = obj.content;
      } else if (obj.content !== null && typeof obj.content === "object") {
        content = JSON.stringify(obj.content, null, 2);
      } else {
        return null;
      }
      return {
        op: "write_file",
        path: p,
        content,
        description: obj.description.trim()
      };
    }

    default:
      return null;
  }
};
