#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve, relative, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { ArchitectRuntime, ArchitectOperationExecutor } from "@opendungeon/architect";
import type { WorldbuilderMessage, WorldbuilderTurnResult, WorldbuilderModuleContext } from "@opendungeon/architect";
import type { ArchitectOperation } from "@opendungeon/architect";
import { c, color, println } from "./lib/output.js";
import { findProjectRoot } from "./lib/project-root.js";
import { readEnvLocal, getEnvValue } from "./lib/env-reader.js";

// ---------------------------------------------------------------------------
// Load .env.local into process.env before anything reads env vars
// ---------------------------------------------------------------------------

const loadEnvLocal = (root: string): void => {
  const envPath = resolve(root, ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
};

const splitFrontmatter = (raw: string): { frontmatter: string; body: string } => {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: normalized };
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
};

const parsePrimitiveFrontmatterValue = (value: string): unknown => {
  const raw = value.trim();
  if (!raw) return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => parsePrimitiveFrontmatterValue(item.trim()))
      .filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return raw;
};

const parseFrontmatterObject = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) return {};
  const output: Record<string, unknown> = {};
  let activeArrayKey: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (activeArrayKey && trimmed.startsWith("- ")) {
      const next = parsePrimitiveFrontmatterValue(trimmed.slice(2).trim());
      if (typeof next === "string" && next.length > 0) {
        (output[activeArrayKey] as string[]).push(next);
      }
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) {
      activeArrayKey = null;
      continue;
    }

    const key = kv[1]!;
    const valueRaw = kv[2] ?? "";
    if (!valueRaw.trim()) {
      output[key] = [];
      activeArrayKey = key;
      continue;
    }

    output[key] = parsePrimitiveFrontmatterValue(valueRaw);
    activeArrayKey = null;
  }

  return output;
};

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const collectDottedKeys = (value: unknown, prefix = ""): string[] => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return prefix ? [prefix] : [];
  if (typeof value !== "object") return prefix ? [prefix] : [];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];
  const keys: string[] = [];
  for (const [k, v] of entries) {
    const next = prefix ? `${prefix}.${k}` : k;
    keys.push(...collectDottedKeys(v, next));
  }
  return keys;
};

const extractWorldReferenceKey = (ref: string): string | null => {
  if (!ref.startsWith("world:")) return null;
  const key = ref.slice("world:".length).trim();
  return key || null;
};

const extractCharacterReferenceKey = (ref: string): string | null => {
  if (!ref.startsWith("character:")) return null;
  const key = ref.slice("character:".length).trim();
  return key || null;
};

const resolveContentBase = async (moduleRoot: string): Promise<string> => {
  const contentDir = resolve(moduleRoot, "content");
  return (await fileExists(contentDir)) ? contentDir : moduleRoot;
};

const readInitialStateFromDisk = async (moduleRoot: string | undefined): Promise<Record<string, unknown> | null> => {
  if (!moduleRoot) return null;
  const contentBase = await resolveContentBase(moduleRoot);
  const initialStatePath = resolve(contentBase, "initial-state.json");
  try {
    const raw = await readFile(initialStatePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const lintArchitectOperations = async (
  pendingOperations: ArchitectOperation[],
  moduleRoot: string | undefined
): Promise<ArchitectLintIssue[]> => {
  const issues: ArchitectLintIssue[] = [];
  const writeOps = pendingOperations.filter((op): op is Extract<ArchitectOperation, { op: "write_file" }> => op.op === "write_file");

  const moduleMdOps = writeOps.filter((op) => /^(modules|contexts)\/.*\.md$/i.test(op.path));
  const initialStateOp = writeOps.find((op) => op.path === "initial-state.json");
  const indicatorOps = writeOps.filter((op) => /^indicators\/.*\.json$/i.test(op.path));

  const referencedWorldKeys = new Set<string>();
  const providedWorldKeys = new Set<string>();
  const characterRefs = new Set<string>();

  for (const op of moduleMdOps) {
    const { frontmatter } = splitFrontmatter(op.content);
    const parsed = parseFrontmatterObject(frontmatter);
    const refs = toStringArray(parsed.references ?? parsed.refs);
    const provides = toStringArray(parsed.provides);
    for (const ref of refs) {
      const worldKey = extractWorldReferenceKey(ref);
      if (worldKey) referencedWorldKeys.add(worldKey);
      const charKey = extractCharacterReferenceKey(ref);
      if (charKey) characterRefs.add(charKey);
    }
    for (const ref of provides) {
      const worldKey = extractWorldReferenceKey(ref);
      if (worldKey) providedWorldKeys.add(worldKey);
      const charKey = extractCharacterReferenceKey(ref);
      if (charKey) characterRefs.add(charKey);
    }
  }

  let effectiveInitialState = await readInitialStateFromDisk(moduleRoot);
  if (initialStateOp) {
    try {
      const parsed = JSON.parse(initialStateOp.content) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        effectiveInitialState = parsed as Record<string, unknown>;
      } else {
        issues.push({ severity: "high", message: "initial-state.json must be a JSON object" });
      }
    } catch {
      issues.push({ severity: "high", message: "initial-state.json content is not valid JSON" });
    }
  }

  if (effectiveInitialState) {
    const worldWrapper = (effectiveInitialState as Record<string, unknown>).world;
    if (worldWrapper && typeof worldWrapper === "object" && !Array.isArray(worldWrapper)) {
      issues.push({
        severity: "high",
        message: "initial-state.json contains nested `world` object; prefer direct keys matching world references (e.g. `merchant.reputation`)"
      });
    }

    const characterWrapper = (effectiveInitialState as Record<string, unknown>).character;
    if (characterWrapper && typeof characterWrapper === "object" && !Array.isArray(characterWrapper)) {
      issues.push({
        severity: "medium",
        message: "initial-state.json contains nested `character` object; verify character-state ownership vs world-state keys"
      });
    }

    const initialKeys = new Set(collectDottedKeys(effectiveInitialState));
    for (const key of referencedWorldKeys) {
      if (!initialKeys.has(key)) {
        issues.push({ severity: "medium", message: `world reference \`${key}\` has no default in effective initial-state.json` });
      }
    }
    for (const key of providedWorldKeys) {
      if (!initialKeys.has(key)) {
        issues.push({ severity: "medium", message: `world provide \`${key}\` has no default in effective initial-state.json` });
      }
    }
  }

  if ((referencedWorldKeys.size > 0 || providedWorldKeys.size > 0) && !effectiveInitialState) {
    issues.push({
      severity: "medium",
      message: "world references/provides are present but no initial-state.json found or proposed"
    });
  }

  if (characterRefs.size > 0 && initialStateOp) {
    issues.push({
      severity: "high",
      message:
        "character references detected together with initial-state.json write; this is ambiguous for characterState ownership and must be clarified"
    });
  }

  for (const op of indicatorOps) {
    try {
      const parsed = JSON.parse(op.content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.varId === "string" && obj.varId.trim()) {
        const key = obj.varId.trim();
        if (!characterRefs.has(key)) {
          issues.push({
            severity: "medium",
            message: `indicator \`${op.path}\` uses varId \`${key}\` but module references/provides do not mention character:${key}`
          });
        }
      }
    } catch {
      issues.push({ severity: "high", message: `indicator file \`${op.path}\` is not valid JSON` });
    }
  }

  return issues;
};

// ---------------------------------------------------------------------------
// Discovery types
// ---------------------------------------------------------------------------

interface DiscoveredModule {
  absPath: string;
  displayPath: string; // relative to cwd, short
  name: string;        // from setting.json "name" or manifest "name" or dir name
}

interface DiscoveredCampaign {
  id: string;
  title: string;
  sessionCount: number;
}

interface ArchitectLintIssue {
  severity: "high" | "medium";
  message: string;
}

// ---------------------------------------------------------------------------
// Module discovery
// ---------------------------------------------------------------------------

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const isModuleDir = async (dir: string): Promise<boolean> => {
  try {
    await access(resolve(dir, "manifest.json"));
    return true;
  } catch {
    return false;
  }
};

const moduleDisplayName = async (dir: string): Promise<string> => {
  const setting = await readJsonFile<{ name?: string }>(resolve(dir, "setting.json"));
  if (setting?.name) return setting.name;
  const manifest = await readJsonFile<{ name?: string }>(resolve(dir, "manifest.json"));
  if (manifest?.name) return manifest.name.replace(/^@[^/]+\//, ""); // strip npm scope
  return dir.split("/").pop() ?? dir;
};

const discoverModules = async (projectRoot: string, envModulePath: string | undefined): Promise<DiscoveredModule[]> => {
  const seen = new Set<string>();
  const results: DiscoveredModule[] = [];

  const add = async (absPath: string): Promise<void> => {
    const normalized = resolve(absPath);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    if (!(await isModuleDir(normalized))) return;
    const name = await moduleDisplayName(normalized);
    const displayPath = relative(process.cwd(), normalized) || normalized;
    results.push({ absPath: normalized, displayPath, name });
  };

  // 1. GAME_MODULE_PATH from .env.local
  if (envModulePath) {
    await add(resolve(projectRoot, envModulePath));
  }

  // 2. games/* inside project root (conventional user game location)
  try {
    const gamesDir = resolve(projectRoot, "games");
    const gameDirs = await readdir(gamesDir);
    for (const d of gameDirs) {
      await add(resolve(gamesDir, d));
    }
  } catch { /* no games dir */ }

  // 3. Sibling directories outside the project root
  try {
    const parent = dirname(projectRoot);
    const siblingDirs = await readdir(parent);
    for (const d of siblingDirs) {
      const candidate = resolve(parent, d);
      if (candidate === projectRoot) continue;
      await add(candidate);
    }
  } catch { /* ignore */ }

  return results;
};

// ---------------------------------------------------------------------------
// Campaign discovery
// ---------------------------------------------------------------------------

const discoverCampaigns = async (prisma: PrismaClient): Promise<DiscoveredCampaign[] | null> => {
  try {
    const rows = await prisma.campaign.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { _count: { select: { sessions: true } } }
    });
    return rows.map((r: { id: string; title: string; _count: { sessions: number } }) => ({
      id: r.id,
      title: r.title,
      sessionCount: r._count.sessions
    }));
  } catch {
    return null; // DB unavailable
  }
};

// ---------------------------------------------------------------------------
// Interactive selection helpers
// ---------------------------------------------------------------------------

const ask = (rl: ReturnType<typeof createInterface>, question: string): Promise<string> =>
  new Promise((res) => rl.question(question, res));

const selectModule = async (
  rl: ReturnType<typeof createInterface>,
  modules: DiscoveredModule[]
): Promise<DiscoveredModule | undefined> => {
  if (modules.length === 0) {
    println(color("  No game directories found. Starting in advisory mode.", c.dim));
    println(color("  Tip: use --module <path> to point to your game content folder.", c.dim));
    println();
    return undefined;
  }

  if (modules.length === 1) {
    println(color(`  Found: ${modules[0]!.name}`, c.dim) + color(` (${modules[0]!.displayPath})`, c.dim));
    println(color("  Using this game directory automatically.", c.dim));
    println();
    return modules[0];
  }

  println(color("  Available game directories:", c.bold));
  modules.forEach((m, i) => {
    println(`    ${color(`${i + 1})`, c.bold)} ${color(m.name, c.bold)}  ${color(m.displayPath, c.dim)}`);
  });
  println(`    ${color("0)", c.bold)} ${color("None — advisory mode only", c.dim)}`);
  println();

  while (true) {
    const raw = (await ask(rl, color("  Choose game (number, Enter = none): ", c.bold))).trim();
    if (!raw || raw === "0") { println(); return undefined; }
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= modules.length) { println(); return modules[n - 1]; }
  }
};

const selectCampaign = async (
  rl: ReturnType<typeof createInterface>,
  campaigns: DiscoveredCampaign[] | null
): Promise<{ id: string; title: string } | undefined> => {
  if (campaigns === null) {
    println(color("  Database not available — campaign operations skipped.", c.dim));
    println();
    return undefined;
  }

  if (campaigns.length === 0) {
    println(color("  No campaigns found in database.", c.dim));
    println(color("  Create one via the web UI or API, then re-run od architect.", c.dim));
    println();
    return undefined;
  }

  println(color("  Campaigns in database:", c.bold));
  campaigns.forEach((camp, i) => {
    const sessions = camp.sessionCount === 1 ? "1 session" : `${camp.sessionCount} sessions`;
    println(`    ${color(`${i + 1})`, c.bold)} ${color(camp.title, c.bold)}  ${color(sessions, c.dim)}`);
  });
  println(`    ${color("0)", c.bold)} ${color("None — skip database operations", c.dim)}`);
  println();

  while (true) {
    const raw = (await ask(rl, color("  Choose campaign (number, Enter = none): ", c.bold))).trim();
    if (!raw || raw === "0") { println(); return undefined; }
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= campaigns.length) {
      println();
      return { id: campaigns[n - 1]!.id, title: campaigns[n - 1]!.title };
    }
  }
};

// ---------------------------------------------------------------------------
// Module context loader
// ---------------------------------------------------------------------------

const fileExists = async (p: string): Promise<boolean> => {
  try { await access(p); return true; } catch { return false; }
};

const listFilesIn = async (dir: string, ext: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(ext)).map((e) => `${dir.split("/").pop()}/${e}`);
  } catch {
    return [];
  }
};

const loadModuleContext = async (
  absModulePath: string | undefined,
  prisma: PrismaClient,
  campaignId: string | undefined
): Promise<WorldbuilderModuleContext> => {
  let availableClasses: string[] = [];
  let existingFiles: string[] | undefined;

  if (absModulePath) {
    const contentBase = await resolveContentBase(absModulePath);
    try {
      const pkgPath = resolve(absModulePath, "package.json");
      let entryPath: string | undefined;
      if (await fileExists(pkgPath)) {
        const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { main?: string };
        if (pkg.main) entryPath = resolve(absModulePath, pkg.main);
      }
      if (!entryPath) {
        for (const candidate of ["src/index.ts", "src/index.js", "index.ts", "index.js"]) {
          const p = resolve(absModulePath, candidate);
          if (await fileExists(p)) { entryPath = p; break; }
        }
      }
      if (entryPath) {
        const loaded = await import(pathToFileURL(entryPath).href);
        const mod = "default" in loaded ? loaded.default : loaded;
        if (mod && typeof mod === "object" && "characters" in mod) {
          const chars = (mod as { characters?: { availableClasses?: unknown } }).characters;
          if (Array.isArray(chars?.availableClasses)) availableClasses = chars.availableClasses as string[];
        }
      }
    } catch { /* best-effort */ }

    const modules = await listFilesIn(resolve(contentBase, "modules"), ".md");
    const contexts = await listFilesIn(resolve(contentBase, "contexts"), ".md");
    const lore = await listFilesIn(resolve(contentBase, "lore"), ".md");
    const indicators = await listFilesIn(resolve(contentBase, "indicators"), ".json");
    const keyJsonFiles = ["setting.json", "dm-config.json", "initial-state.json"];
    const presentJsonFiles: string[] = [];
    if (await fileExists(resolve(absModulePath, "manifest.json"))) presentJsonFiles.push("manifest.json");
    for (const file of keyJsonFiles) {
      if (await fileExists(resolve(contentBase, file))) presentJsonFiles.push(file);
    }

    existingFiles = [...presentJsonFiles, ...modules, ...contexts, ...lore, ...indicators];
  }

  let existingWorldState: Record<string, unknown> = {};
  let existingLore: Array<{ entityName: string; type: string; description: string }> = [];

  if (campaignId) {
    try {
      const worldFacts = await prisma.worldFact.findMany({ where: { campaignId } });
      for (const fact of worldFacts) existingWorldState[fact.key] = fact.value;
      const loreRows = await prisma.loreEntry.findMany({ where: { campaignId } });
      existingLore = loreRows.map((l: { entityName: string; type: string; description: string }) => ({
        entityName: l.entityName,
        type: l.type,
        description: l.description
      }));
    } catch { /* DB not available */ }
  }

  return { availableClasses, existingWorldState, existingLore, modulePath: absModulePath, existingFiles };
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const PREVIEW_LINES = 25;

const previewContent = (content: string): string => {
  const lines = content.split("\n");
  if (lines.length <= PREVIEW_LINES) return content;
  return lines.slice(0, PREVIEW_LINES).join("\n") + `\n  ${color(`... (${lines.length - PREVIEW_LINES} more lines)`, c.dim)}`;
};

const formatOperation = (op: ArchitectOperation, index: number): string => {
  const num = color(`${index + 1}.`, c.bold);
  if (op.op === "write_file") {
    const header = `${num} ${color("write_file", c.cyan)} ${color(op.path, c.bold)} — ${op.description}`;
    const preview = previewContent(op.content).split("\n").map((l) => `     ${color(l, c.dim)}`).join("\n");
    return `  ${header}\n${preview}`;
  }
  if (op.op === "set_world_fact") {
    return `  ${num} ${color("set_world_fact", c.yellow)} ${color(op.key, c.bold)} = ${JSON.stringify(op.value)}`;
  }
  if (op.op === "upsert_lore") {
    return `  ${num} ${color("upsert_lore", c.blue)} ${color(op.entityName, c.bold)} (${op.type}) — ${op.description.slice(0, 80)}${op.description.length > 80 ? "…" : ""}`;
  }
  const opStr = JSON.stringify(op, null, 2).split("\n").map((l) => `     ${color(l, c.dim)}`).join("\n");
  return `  ${num} ${color(op.op, c.yellow)}\n${opStr}`;
};

const printHelp = (): void => {
  println();
  println(color("Architect Worldbuilder — Commands", c.bold));
  println();
  println("  " + color("help", c.cyan) + "          Show this help message");
  println("  " + color("exit", c.cyan) + " / " + color("quit", c.cyan) + "   Exit the chat");
  println("  " + color("--strict-ops", c.cyan) + "   Block apply when high-severity pre-apply issues are detected");
  println();
  println(color("  Anything else is sent to the Architect as a request.", c.dim));
  println(color("  Examples:", c.dim));
  println(color("    add stamina module with references/provides and matching indicator", c.dim));
  println(color("    create a negotiation module and align world keys in initial-state", c.dim));
  println(color("    explain how references/dependsOn affect routing", c.dim));
  println(color("    add an NPC: Gorm the blacksmith, neutral, knows secret passages", c.dim));
  println(color("    how does the turn pipeline work?", c.dim));
  println();
};

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const printBanner = (
  module: DiscoveredModule | undefined,
  campaign: { id: string; title: string } | undefined,
  existingFiles: string[]
): void => {
  const llmProvider = process.env.LLM_PROVIDER ?? "mock";
  const llmModel = process.env.LLM_ARCHITECT_MODEL ?? process.env.LLM_MODEL;
  const isMock = llmProvider === "mock";
  const providerLabel = isMock
    ? color("mock (no real LLM configured)", c.yellow)
    : color(`${llmProvider} / ${llmModel ?? "unknown model"}`, c.green);

  println();
  println(color("╔══════════════════════════════════════════════╗", c.cyan));
  println(color("║  OpenDungeon Architect                       ║", c.cyan));
  println(color("╚══════════════════════════════════════════════╝", c.cyan));
  println();
  println(color("  Provider : ", c.dim) + providerLabel);

  if (campaign) {
    println(color("  Campaign : ", c.dim) + color(campaign.title, c.bold) + color(` (${campaign.id})`, c.dim));
  } else {
    println(color("  Campaign : ", c.dim) + color("none — lore/world-fact operations skipped", c.dim));
  }

  if (module) {
    println(color("  Game     : ", c.dim) + color(module.name, c.bold) + color(`  (${module.displayPath})`, c.dim));
    if (existingFiles.length > 0) {
      println(color(`  Files    : ${existingFiles.join(", ")}`, c.dim));
    } else {
      println(color("  Files    : (no content files yet)", c.dim));
    }
  } else {
    println(color("  Game     : ", c.dim) + color("none — file operations skipped", c.dim));
  }

  if (isMock) {
    println();
    println(color("  ! LLM not configured. Run `od configure llm` to set up a real provider.", c.yellow));
  }

  println();
  println(color("  Type your request, 'help' for examples, 'exit' to quit.", c.dim));
  println();
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const runArchitectCli = async (args: string[]): Promise<void> => {
  // Flags: override auto-discovery when explicitly provided
  let campaignIdOverride: string | undefined;
  let modulePathOverride: string | undefined;
  let autoApply = false;
  let strictOps = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--campaign" && args[i + 1]) campaignIdOverride = args[++i];
    else if (args[i] === "--module" && args[i + 1]) modulePathOverride = args[++i];
    else if (args[i] === "--apply") autoApply = true;
    else if (args[i] === "--strict-ops") strictOps = true;
  }

  // Find project root and load env
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot();
  } catch {
    process.stderr.write("Run od architect from inside your OpenDungeon project directory.\n");
    process.exit(1);
  }
  loadEnvLocal(projectRoot);

  const prisma = new PrismaClient();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // -------------------------------------------------------------------------
  // Phase 1: Resolve module and campaign — auto-discover or use overrides
  // -------------------------------------------------------------------------

  let resolvedModule: DiscoveredModule | undefined;
  let resolvedCampaign: { id: string; title: string } | undefined;

  if (modulePathOverride || campaignIdOverride) {
    // Explicit flags — skip discovery UI
    if (modulePathOverride) {
      const abs = resolve(process.cwd(), modulePathOverride);
      const name = await moduleDisplayName(abs);
      const displayPath = relative(process.cwd(), abs) || abs;
      resolvedModule = { absPath: abs, displayPath, name };
    }
    if (campaignIdOverride) {
      const row = await prisma.campaign.findUnique({ where: { id: campaignIdOverride } }).catch(() => null);
      if (!row) {
        process.stderr.write(`Campaign not found: ${campaignIdOverride}\n`);
        await prisma.$disconnect();
        rl.close();
        process.exit(1);
      }
      resolvedCampaign = { id: row.id, title: row.title };
    }
  } else {
    // Auto-discovery flow
    println();
    println(color("Discovering your game setup…", c.bold));
    println();

    const envMap = readEnvLocal(projectRoot);
    const envModulePath = getEnvValue(envMap, "GAME_MODULE_PATH");

    const [modules, campaigns] = await Promise.all([
      discoverModules(projectRoot, envModulePath),
      discoverCampaigns(prisma)
    ]);

    resolvedModule = await selectModule(rl, modules);

    println(color("Campaigns (for seeding lore and world facts):", c.bold));
    resolvedCampaign = await selectCampaign(rl, campaigns);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Banner + REPL
  // -------------------------------------------------------------------------

  const absModulePath = resolvedModule?.absPath;
  const initialContext = await loadModuleContext(absModulePath, prisma, resolvedCampaign?.id);

  printBanner(resolvedModule, resolvedCampaign, initialContext.existingFiles ?? []);

  const architect = new ArchitectRuntime();
  const executor = new ArchitectOperationExecutor(prisma, absModulePath);
  const conversationHistory: WorldbuilderMessage[] = [];

  const prompt = (): void => {
    rl.question(color("> ", c.bold + c.cyan), async (userInput) => {
      const trimmed = userInput.trim();

      if (!trimmed) { prompt(); return; }

      if (trimmed === "help") { printHelp(); prompt(); return; }

      if (trimmed === "exit" || trimmed === "quit") {
        println(color("Goodbye.", c.dim));
        await prisma.$disconnect();
        rl.close();
        return;
      }

      try {
        const moduleContext = await loadModuleContext(absModulePath, prisma, resolvedCampaign?.id);

        const result: WorldbuilderTurnResult = await architect.runWorldbuilderTurn({
          conversationHistory,
          userMessage: trimmed,
          moduleContext
        });

        println();
        println(color("Architect:", c.bold + c.green) + " " + result.assistantMessage);

        if (result.reviewerSummary) {
          println(color("  Reviewer:", c.dim) + " " + color(result.reviewerSummary, c.dim));
        }

        conversationHistory.push({ role: "user", content: trimmed });
        conversationHistory.push({ role: "assistant", content: result.assistantMessage });

        if (result.droppedOperationCount > 0) {
          println(color(`  ! ${result.droppedOperationCount} operation(s) from LLM response failed validation and were dropped.`, c.yellow));
          const details = result.droppedOperations.slice(0, 5);
          for (const drop of details) {
            const ref = drop.path ? `${drop.op ?? "operation"} ${drop.path}` : (drop.op ?? `operation #${drop.index + 1}`);
            println(color(`    - ${ref}: ${drop.reason}`, c.dim));
          }
          if (result.droppedOperations.length > details.length) {
            println(color(`    - ... and ${result.droppedOperations.length - details.length} more`, c.dim));
          }
        }

        if (result.pendingOperations.length === 0) {
          println();
          prompt();
          return;
        }

        println();
        println(color(`Pending operations (${result.pendingOperations.length}):`, c.bold));
        result.pendingOperations.forEach((op, i) => println(formatOperation(op, i)));

        if (result.operationAssessments.length > 0) {
          println();
          println(color("Operation confidence:", c.bold));
          result.operationAssessments.forEach((a) => {
            const ref = typeof a.opIndex === "number" ? `#${a.opIndex + 1}` : (a.path ? a.path : "(unmapped)");
            const tone = a.confidence === "high" ? c.green : a.confidence === "medium" ? c.yellow : c.red;
            println(`  ${color(ref, c.bold)} ${color(a.confidence, tone)} — ${color(a.rationale, c.dim)}`);
          });
        }

        const lintIssues = await lintArchitectOperations(result.pendingOperations, absModulePath);
        if (lintIssues.length > 0) {
          println();
          println(color("Pre-apply checks:", c.bold));
          for (const issue of lintIssues) {
            const icon = issue.severity === "high" ? "✗" : "!";
            const tone = issue.severity === "high" ? c.red : c.yellow;
            println(`  ${color(icon, tone)} ${issue.message}`);
          }
        }
        println();

        const hasBlockingIssues = lintIssues.some((issue) => issue.severity === "high");
        if (strictOps && hasBlockingIssues) {
          println(color("Strict mode blocked apply due to high-severity pre-apply issues. Regenerate or fix the proposal.", c.red));
          println();
          prompt();
          return;
        }

        const applyOps = async (): Promise<void> => {
          const dummyCampaignId = resolvedCampaign?.id ?? "no-campaign";
          const report = await executor.execute(result.pendingOperations, dummyCampaignId);

          for (const e of report.errors) {
            process.stderr.write(color(`  ✗ Error (${e.op.op}): ${e.reason}\n`, c.red));
          }

          // Verify each write_file operation actually landed on disk
          for (const op of result.pendingOperations) {
            if (op.op !== "write_file") continue;
            if (!absModulePath) continue;
            const filePath = resolve(absModulePath, op.path);
            try {
              const info = await stat(filePath);
              println(color(`  ✓ ${op.path}`, c.green) + color(` (${info.size} bytes)`, c.dim));
            } catch {
              println(color(`  ✗ ${op.path} — not found on disk after write`, c.red));
            }
          }

          if (report.applied > 0 && result.pendingOperations.every(o => o.op !== "write_file")) {
            println(color(`  ✓ ${report.applied} database operation(s) applied.`, c.green));
          }

          println();
        };

        if (autoApply) {
          await applyOps();
          prompt();
        } else {
          rl.question(color("Apply these operations? [y/N] ", c.bold), async (answer) => {
            if (answer.trim().toLowerCase() === "y") {
              await applyOps();
            } else {
              println(color("  Skipped.", c.dim));
              println();
            }
            prompt();
          });
        }
      } catch (err) {
        process.stderr.write(color(`Error: ${err instanceof Error ? err.message : String(err)}\n`, c.red));
        prompt();
      }
    });
  };

  prompt();
};
