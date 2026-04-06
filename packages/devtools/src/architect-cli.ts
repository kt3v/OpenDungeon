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
    return rows.map((r) => ({
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

    const skills = await listFilesIn(resolve(absModulePath, "skills"), ".json");
    const hooks  = await listFilesIn(resolve(absModulePath, "hooks"),  ".json");
    const rules  = await listFilesIn(resolve(absModulePath, "rules"),  ".json");
    const lore   = await listFilesIn(resolve(absModulePath, "lore"),   ".md");
    existingFiles = [...skills, ...hooks, ...rules, ...lore];
  }

  let existingWorldState: Record<string, unknown> = {};
  let existingLore: Array<{ entityName: string; type: string; description: string }> = [];

  if (campaignId) {
    try {
      const worldFacts = await prisma.worldFact.findMany({ where: { campaignId } });
      for (const fact of worldFacts) existingWorldState[fact.key] = fact.value;
      const loreRows = await prisma.loreEntry.findMany({ where: { campaignId } });
      existingLore = loreRows.map((l) => ({ entityName: l.entityName, type: l.type, description: l.description }));
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
  println();
  println(color("  Anything else is sent to the Architect as a request.", c.dim));
  println(color("  Examples:", c.dim));
  println(color("    create a 'meditate' skill to recover HP (deterministic)", c.dim));
  println(color("    add a starting-gear hook that gives Warriors a sword", c.dim));
  println(color("    write a death-check rule that ends the session when HP ≤ 0", c.dim));
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--campaign" && args[i + 1]) campaignIdOverride = args[++i];
    else if (args[i] === "--module" && args[i + 1]) modulePathOverride = args[++i];
    else if (args[i] === "--apply") autoApply = true;
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

        conversationHistory.push({ role: "user", content: trimmed });
        conversationHistory.push({ role: "assistant", content: result.assistantMessage });

        if (result.droppedOperationCount > 0) {
          println(color(`  ! ${result.droppedOperationCount} operation(s) from LLM response failed validation and were dropped.`, c.yellow));
        }

        if (result.pendingOperations.length === 0) {
          println();
          prompt();
          return;
        }

        println();
        println(color(`Pending operations (${result.pendingOperations.length}):`, c.bold));
        result.pendingOperations.forEach((op, i) => println(formatOperation(op, i)));
        println();

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
