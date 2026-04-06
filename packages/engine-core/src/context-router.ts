import { approximateTokens, stripCodeFence } from "@opendungeon/shared";
import type { LlmProvider } from "@opendungeon/providers-llm";

export interface RouterContextModule {
  id: string;
  content: string;
  priority?: number;
  alwaysInclude?: boolean;
  triggers?: string[];
  file?: string;
}

export interface RouterConfig {
  enabled?: boolean;
  contextTokenBudget?: number;
  maxCandidates?: number;
  maxSelectedModules?: number;
}

export interface ContextRouterSelection {
  selectedModules: RouterContextModule[];
  selectedIds: string[];
}

export interface ContextRouterSelectInput {
  actionText: string;
  worldState: Record<string, unknown>;
  modules: RouterContextModule[];
  config?: RouterConfig;
}

const DEFAULT_CONTEXT_TOKEN_BUDGET = 1200;
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_SELECTED_MODULES = 4;

export class ContextRouterRuntime {
  constructor(private readonly provider: LlmProvider) {}

  async selectModules(input: ContextRouterSelectInput): Promise<ContextRouterSelection> {
    if (input.modules.length === 0) {
      return { selectedModules: [], selectedIds: [] };
    }

    const config = resolveRouterConfig(input.config);

    const baseline = input.modules
      .filter((module) => module.alwaysInclude)
      .sort(sortByPriorityDesc);

    const nonBaseline = input.modules.filter((module) => !module.alwaysInclude);
    const prefCandidates = selectKeywordCandidates(nonBaseline, input.actionText, config.maxCandidates);

    const llmSelectedIds = prefCandidates.length > 0
      ? await this.pickByLlm({
          actionText: input.actionText,
          worldState: input.worldState,
          candidates: prefCandidates,
          maxSelectedModules: Math.max(config.maxSelectedModules - baseline.length, 0)
        })
      : [];

    const llmSelected = prefCandidates.filter((module) => llmSelectedIds.includes(module.id));

    const prioritized = [...baseline, ...llmSelected]
      .sort(sortByPriorityDesc)
      .slice(0, config.maxSelectedModules);

    const budgeted = applyTokenBudget(prioritized, config.contextTokenBudget);

    return {
      selectedModules: budgeted,
      selectedIds: budgeted.map((module) => module.id)
    };
  }

  private async pickByLlm(input: {
    actionText: string;
    worldState: Record<string, unknown>;
    candidates: RouterContextModule[];
    maxSelectedModules: number;
  }): Promise<string[]> {
    if (input.maxSelectedModules <= 0) {
      return [];
    }

    const response = await this.provider.createResponse({
      temperature: 0,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a context module router for a Dungeon Master prompt.",
            "Choose only modules directly relevant to the player action.",
            "Return strict JSON only in the form {\"selectedModuleIds\": string[]}"
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            actionText: input.actionText,
            maxSelectedModules: input.maxSelectedModules,
            worldStatePreview: buildWorldStatePreview(input.worldState),
            candidates: input.candidates.map((candidate) => ({
              id: candidate.id,
              priority: candidate.priority ?? 0,
              triggers: candidate.triggers ?? [],
              preview: candidate.content.slice(0, 280)
            }))
          })
        }
      ]
    });

    return parseSelectedModuleIds(response.text)
      .filter((id) => input.candidates.some((candidate) => candidate.id === id))
      .slice(0, input.maxSelectedModules);
  }
}

const resolveRouterConfig = (
  config: RouterConfig | undefined
): Required<RouterConfig> => ({
  enabled: config?.enabled ?? false,
  contextTokenBudget: config?.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
  maxCandidates: config?.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
  maxSelectedModules: config?.maxSelectedModules ?? DEFAULT_MAX_SELECTED_MODULES
});

const tokenizeAction = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const selectKeywordCandidates = (
  modules: RouterContextModule[],
  actionText: string,
  maxCandidates: number
): RouterContextModule[] => {
  const tokens = new Set(tokenizeAction(actionText));

  const scored = modules
    .map((module) => {
      const triggerScore = (module.triggers ?? []).reduce((score: number, trigger: string) => {
        const normalized = trigger.toLowerCase().trim();
        return tokens.has(normalized) ? score + 1 : score;
      }, 0);

      return {
        module,
        triggerScore
      };
    })
    .filter((entry) => entry.triggerScore > 0 || (entry.module.triggers ?? []).length === 0)
    .sort((a, b) => {
      if (b.triggerScore !== a.triggerScore) return b.triggerScore - a.triggerScore;
      return (b.module.priority ?? 0) - (a.module.priority ?? 0);
    })
    .slice(0, maxCandidates)
    .map((entry) => entry.module);

  if (scored.length > 0) {
    return scored;
  }

  return [...modules]
    .sort(sortByPriorityDesc)
    .slice(0, maxCandidates);
};

const applyTokenBudget = (
  modules: RouterContextModule[],
  contextTokenBudget: number
): RouterContextModule[] => {
  const alwaysInclude = modules.filter((module) => module.alwaysInclude);
  const optional = modules.filter((module) => !module.alwaysInclude);

  let consumed = alwaysInclude.reduce((sum, module) => sum + approximateTokens(module.content), 0);
  const selected = [...alwaysInclude];

  for (const module of optional) {
    const tokens = approximateTokens(module.content);
    if (consumed + tokens > contextTokenBudget) continue;
    selected.push(module);
    consumed += tokens;
  }

  return selected.sort(sortByPriorityDesc);
};

const sortByPriorityDesc = (a: RouterContextModule, b: RouterContextModule): number =>
  (b.priority ?? 0) - (a.priority ?? 0);

const parseSelectedModuleIds = (raw: string): string[] => {
  const normalized = stripCodeFence(raw).trim();

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.selectedModuleIds)) return [];
    return obj.selectedModuleIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const buildWorldStatePreview = (worldState: Record<string, unknown>): Record<string, unknown> => {
  const entries = Object.entries(worldState).slice(0, 20);
  const preview: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    if (value == null) {
      preview[key] = value;
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      preview[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      preview[key] = `[array:${value.length}]`;
      continue;
    }

    preview[key] = "[object]";
  }

  return preview;
};
