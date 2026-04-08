import type { LlmProvider } from "@opendungeon/providers-llm";

export interface RouterContextModule {
  id: string;
  content: string;
  source?: "module" | "lore";
  priority?: number;
  alwaysInclude?: boolean;
  triggers?: string[];
  dependsOn?: string[];
  references?: string[];
  provides?: string[];
  when?: string[];
  file?: string;
}

export interface RouterConfig {
  enabled?: boolean;
  contextTokenBudget?: number;
  maxCandidates?: number;
  maxSelectedModules?: number;
  forceLlmSelection?: boolean;
}

export interface ContextRouterSelection {
  selectedModules: RouterContextModule[];
  selectedIds: string[];
  diagnostics: {
    baselineIds: string[];
    baselineApproxTokens: number;
    prefCandidateIds: string[];
    llmSelectedIds: string[];
    heuristicSelectedIds?: string[];
    skippedLlmReason?: "no_capacity" | "no_budget" | "no_fitting_candidates" | "heuristic_confident";
  };
}

type CandidateScoreEntry = {
  module: RouterContextModule;
  triggerScore: number;
  contentScore: number;
  whenScore: number;
  referenceScore: number;
  totalScore: number;
};

export interface ContextRouterSelectInput {
  actionText: string;
  worldState: Record<string, unknown>;
  modules: RouterContextModule[];
  config?: RouterConfig;
}

const DEFAULT_CONTEXT_TOKEN_BUDGET = 1800;
const DEFAULT_MAX_CANDIDATES = 16;
const DEFAULT_MAX_SELECTED_MODULES = 8;

export class ContextRouterRuntime {
  constructor(private readonly provider: LlmProvider) {}

  async selectModules(input: ContextRouterSelectInput): Promise<ContextRouterSelection> {
    if (input.modules.length === 0) {
      return {
        selectedModules: [],
        selectedIds: [],
        diagnostics: {
          baselineIds: [],
          baselineApproxTokens: 0,
          prefCandidateIds: [],
          llmSelectedIds: []
        }
      };
    }

    const config = resolveRouterConfig(input.config);

    const worldStatePaths = buildWorldStatePathSet(input.worldState);

    const baseline = input.modules
      .filter((module) => module.alwaysInclude)
      .sort(sortByPriorityDesc);
    const baselineIds = baseline.map((module) => module.id);
    const baselineApproxTokens = baseline.reduce((sum, module) => sum + approximateTokens(module.content), 0);

    const nonBaseline = input.modules.filter((module) => !module.alwaysInclude);
    const prefCandidateEntries = selectKeywordCandidates(nonBaseline, input.actionText, worldStatePaths, config.maxCandidates);
    const prefCandidates = prefCandidateEntries.map((entry) => entry.module);
    const prefCandidateIds = prefCandidates.map((module) => module.id);

    const remainingModuleSlots = Math.max(config.maxSelectedModules - baseline.length, 0);
    const remainingTokenBudget = Math.max(config.contextTokenBudget - baselineApproxTokens, 0);
    const hasFittingCandidate = prefCandidates.some((module) => approximateTokens(module.content) <= remainingTokenBudget);
    const heuristicSelected = selectHeuristicCandidates(prefCandidateEntries, remainingModuleSlots, remainingTokenBudget);

    let skippedLlmReason: ContextRouterSelection["diagnostics"]["skippedLlmReason"];
    if (remainingModuleSlots <= 0) {
      skippedLlmReason = "no_capacity";
    } else if (remainingTokenBudget <= 0) {
      skippedLlmReason = "no_budget";
    } else if (prefCandidates.length > 0 && !hasFittingCandidate) {
      skippedLlmReason = "no_fitting_candidates";
    } else if (heuristicSelected.length > 0 && !config.forceLlmSelection) {
      skippedLlmReason = "heuristic_confident";
    }

    const llmSelectedIds = skippedLlmReason === "heuristic_confident"
      ? []
      : prefCandidates.length > 0 && !skippedLlmReason
      ? await this.pickByLlm({
          actionText: input.actionText,
          worldState: input.worldState,
          candidates: prefCandidates,
          maxSelectedModules: remainingModuleSlots
        })
      : [];

    const llmSelected = skippedLlmReason === "heuristic_confident"
      ? heuristicSelected
      : prefCandidates.filter((module) => llmSelectedIds.includes(module.id));

    const expanded = expandWithDependencies({
      selectedModules: [...baseline, ...llmSelected],
      allModules: input.modules,
      maxSelectedModules: config.maxSelectedModules
    });

    const prioritized = rankByReferenceImpact(expanded, worldStatePaths)
      .slice(0, config.maxSelectedModules);

    const budgeted = applyTokenBudget(prioritized, config.contextTokenBudget);

    return {
      selectedModules: budgeted,
      selectedIds: budgeted.map((module) => module.id),
      diagnostics: {
        baselineIds,
        baselineApproxTokens,
        prefCandidateIds,
        llmSelectedIds,
        heuristicSelectedIds: heuristicSelected.map((module) => module.id),
        ...(skippedLlmReason ? { skippedLlmReason } : {})
      }
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
              references: candidate.references ?? [],
              provides: candidate.provides ?? [],
              dependsOn: candidate.dependsOn ?? [],
              when: candidate.when ?? [],
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
  maxSelectedModules: config?.maxSelectedModules ?? DEFAULT_MAX_SELECTED_MODULES,
  forceLlmSelection: config?.forceLlmSelection ?? ["1", "true", "yes", "on"].includes((process.env.DM_CONTEXT_ROUTER_FORCE_LLM ?? "").trim().toLowerCase())
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
  worldStatePaths: Set<string>,
  maxCandidates: number
): CandidateScoreEntry[] => {
  const tokens = new Set(tokenizeAction(actionText));

  const scored = modules
    .map((module) => {
      const triggerScore = (module.triggers ?? []).reduce((score: number, trigger: string) => {
        const normalized = trigger.toLowerCase().trim();
        return tokens.has(normalized) ? score + 1 : score;
      }, 0);

      const contentScore = countContentTokenMatches(module, tokens);

      const whenScore = (module.when ?? []).reduce((score: number, tag: string) => {
        const normalized = tag.toLowerCase().trim();
        return tokens.has(normalized) ? score + 1 : score;
      }, 0);

      const referenceScore = countWorldReferenceMatches(module.references, worldStatePaths);

      return {
        module,
        triggerScore,
        contentScore,
        whenScore,
        referenceScore,
        totalScore: triggerScore * 4 + contentScore * 2 + referenceScore * 3 + whenScore
      };
    })
    .filter((entry) => {
      const hasLooseRouting =
        (entry.module.triggers ?? []).length === 0 &&
        (entry.module.references ?? []).length === 0 &&
        (entry.module.when ?? []).length === 0;

        return entry.triggerScore > 0 || entry.contentScore > 0 || entry.referenceScore > 0 || entry.whenScore > 0 || hasLooseRouting;
      })
    .sort((a, b) => {
      if (b.triggerScore !== a.triggerScore) return b.triggerScore - a.triggerScore;
      if (b.contentScore !== a.contentScore) return b.contentScore - a.contentScore;
      if (b.referenceScore !== a.referenceScore) return b.referenceScore - a.referenceScore;
      if (b.whenScore !== a.whenScore) return b.whenScore - a.whenScore;
      return (b.module.priority ?? 0) - (a.module.priority ?? 0);
    })
    .slice(0, maxCandidates);

  if (scored.length > 0) {
    return scored;
  }

  return [...modules]
    .sort(sortByPriorityDesc)
    .slice(0, maxCandidates)
    .map((module) => ({
      module,
      triggerScore: 0,
      contentScore: 0,
      whenScore: 0,
      referenceScore: 0,
      totalScore: 0
    }));
};

const selectHeuristicCandidates = (
  entries: CandidateScoreEntry[],
  remainingModuleSlots: number,
  remainingTokenBudget: number
): RouterContextModule[] => {
  if (remainingModuleSlots <= 0 || remainingTokenBudget <= 0 || entries.length === 0) {
    return [];
  }

  const topScore = entries[0]?.totalScore ?? 0;
  const secondScore = entries[1]?.totalScore ?? 0;
  const likelyConfident =
    entries.length <= Math.max(remainingModuleSlots + 2, 6) ||
    topScore >= 8 ||
    (topScore >= 5 && topScore - secondScore >= 2);

  if (!likelyConfident) {
    return [];
  }

  let consumed = 0;
  const selected: RouterContextModule[] = [];

  for (const entry of entries) {
    if (selected.length >= remainingModuleSlots) break;
    const tokens = approximateTokens(entry.module.content);
    if (consumed + tokens > remainingTokenBudget) continue;
    if (entry.totalScore <= 0) continue;
    selected.push(entry.module);
    consumed += tokens;
  }

  if (selected.length === 0) {
    return [];
  }

  const selectedScores = entries
    .filter((entry) => selected.some((module) => module.id === entry.module.id))
    .map((entry) => entry.totalScore);

  const minSelectedScore = Math.min(...selectedScores);
  if (minSelectedScore < 2 && entries.length > selected.length + 1) {
    return [];
  }

  return selected;
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

const buildWorldStatePathSet = (worldState: Record<string, unknown>): Set<string> => {
  const paths = new Set<string>();

  const visit = (prefix: string, value: unknown, depth: number): void => {
    paths.add(prefix);
    if (depth >= 2) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;

    for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
      if (!key.trim()) continue;
      visit(`${prefix}.${key}`, next, depth + 1);
    }
  };

  for (const [key, value] of Object.entries(worldState)) {
    if (!key.trim()) continue;
    visit(key, value, 0);
  }

  return paths;
};

const normalizeModuleDependencyRef = (value: string): string | null => {
  const raw = value.trim();
  if (!raw) return null;
  if (raw.startsWith("module:")) {
    const id = raw.slice("module:".length).trim();
    return id || null;
  }
  return raw;
};

const normalizeMachineRef = (value: string): { kind: string; path: string } | null => {
  const raw = value.trim();
  const match = raw.match(/^(world|character|resource|module):([A-Za-z0-9_.-]+)$/);
  if (!match) return null;
  return {
    kind: match[1] ?? "",
    path: match[2] ?? ""
  };
};

const pathMatches = (referencePath: string, statePath: string): boolean =>
  statePath === referencePath || statePath.startsWith(`${referencePath}.`) || referencePath.startsWith(`${statePath}.`);

const countWorldReferenceMatches = (references: string[] | undefined, worldStatePaths: Set<string>): number => {
  if (!references || references.length === 0 || worldStatePaths.size === 0) return 0;

  let matches = 0;
  for (const ref of references) {
    const parsed = normalizeMachineRef(ref);
    if (!parsed || parsed.kind !== "world") continue;
    if ([...worldStatePaths].some((statePath) => pathMatches(parsed.path, statePath))) {
      matches += 1;
    }
  }
  return matches;
};

const countContentTokenMatches = (module: RouterContextModule, tokens: Set<string>): number => {
  if (tokens.size === 0) return 0;

  const searchableParts = [
    module.id,
    module.file ?? "",
    ...(module.triggers ?? []),
    ...(module.when ?? []),
    ...extractHeadingKeywords(module.content),
    ...extractContentKeywords(module.content)
  ];

  const keywordSet = new Set(
    searchableParts
      .flatMap((part) => tokenizeAction(part))
      .filter((token) => token.length >= 3)
  );

  let matches = 0;
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (keywordSet.has(token)) matches += 1;
  }

  return matches;
};

const extractHeadingKeywords = (content: string): string[] =>
  content
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .slice(0, 6)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean);

const extractContentKeywords = (content: string): string[] =>
  content
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 4)
    .slice(0, 80);

const countModuleReferenceMatches = (references: string[] | undefined, selectedIds: Set<string>): number => {
  if (!references || references.length === 0 || selectedIds.size === 0) return 0;

  let matches = 0;
  for (const ref of references) {
    const parsed = normalizeMachineRef(ref);
    if (!parsed || parsed.kind !== "module") continue;
    if (selectedIds.has(parsed.path)) {
      matches += 1;
    }
  }
  return matches;
};

const expandWithDependencies = (input: {
  selectedModules: RouterContextModule[];
  allModules: RouterContextModule[];
  maxSelectedModules: number;
}): RouterContextModule[] => {
  const byId = new Map(input.allModules.map((module) => [module.id, module]));
  const selected = [...input.selectedModules];
  const selectedIds = new Set(selected.map((module) => module.id));

  for (let i = 0; i < selected.length; i += 1) {
    if (selected.length >= input.maxSelectedModules) break;

    const module = selected[i];
    if (!module) continue;
    for (const dep of module.dependsOn ?? []) {
      if (selected.length >= input.maxSelectedModules) break;
      const depId = normalizeModuleDependencyRef(dep);
      if (!depId || selectedIds.has(depId)) continue;

      const dependencyModule = byId.get(depId);
      if (!dependencyModule) continue;

      selected.push(dependencyModule);
      selectedIds.add(depId);
    }
  }

  return selected;
};

const rankByReferenceImpact = (
  modules: RouterContextModule[],
  worldStatePaths: Set<string>
): RouterContextModule[] => {
  const selectedIds = new Set(modules.map((module) => module.id));

  return [...modules].sort((a, b) => {
    const aScore =
      (a.priority ?? 0) +
      countWorldReferenceMatches(a.references, worldStatePaths) * 30 +
      countModuleReferenceMatches(a.references, selectedIds) * 20 +
      countWorldReferenceMatches(a.provides, worldStatePaths) * 6;

    const bScore =
      (b.priority ?? 0) +
      countWorldReferenceMatches(b.references, worldStatePaths) * 30 +
      countModuleReferenceMatches(b.references, selectedIds) * 20 +
      countWorldReferenceMatches(b.provides, worldStatePaths) * 6;

    if (bScore !== aScore) return bScore - aScore;
    return sortByPriorityDesc(a, b);
  });
};

const approximateTokens = (value: string): number =>
  Math.ceil(Buffer.byteLength(value, "utf8") / 4);

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

const stripCodeFence = (value: string): string => {
  if (value.startsWith("```") && value.endsWith("```")) {
    const lines = value.split("\n");
    return lines.slice(1, -1).join("\n");
  }
  return value;
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
