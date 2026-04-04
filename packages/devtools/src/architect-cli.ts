#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { access, readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { ArchitectRuntime, ArchitectOperationExecutor } from "@opendungeon/architect";
import type { WorldbuilderMessage, WorldbuilderTurnResult } from "@opendungeon/architect";
import type { ArchitectOperation } from "@opendungeon/architect";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const loadModuleContext = async (
  modulePath: string | undefined,
  prisma: PrismaClient,
  campaignId: string
): Promise<{ availableClasses: string[]; existingWorldState: Record<string, unknown>; existingLore: Array<{ entityName: string; type: string; description: string }> }> => {
  let availableClasses: string[] = [];

  if (modulePath) {
    try {
      const absPath = resolve(process.cwd(), modulePath);
      const pkgPath = resolve(absPath, "package.json");
      let entryPath: string | undefined;

      if (await fileExists(pkgPath)) {
        const pkgRaw = await readFile(pkgPath, "utf8");
        const pkg = JSON.parse(pkgRaw) as { main?: string };
        if (pkg.main) entryPath = resolve(absPath, pkg.main);
      }

      if (!entryPath) {
        for (const candidate of ["src/index.ts", "src/index.js", "index.ts", "index.js"]) {
          const candidatePath = resolve(absPath, candidate);
          if (await fileExists(candidatePath)) {
            entryPath = candidatePath;
            break;
          }
        }
      }

      if (entryPath) {
        const loaded = await import(pathToFileURL(entryPath).href);
        const mod = "default" in loaded ? loaded.default : loaded;
        if (mod && typeof mod === "object" && "characters" in mod) {
          const chars = (mod as { characters?: { availableClasses?: unknown } }).characters;
          if (Array.isArray(chars?.availableClasses)) {
            availableClasses = chars.availableClasses as string[];
          }
        }
      }
    } catch {
      // Module load is best-effort — proceed without classes
    }
  }

  const worldFacts = await prisma.worldFact.findMany({ where: { campaignId } });
  const existingWorldState: Record<string, unknown> = {};
  for (const fact of worldFacts) {
    existingWorldState[fact.key] = fact.value;
  }

  const loreRows = await prisma.loreEntry.findMany({ where: { campaignId } });
  const existingLore = loreRows.map((l) => ({
    entityName: l.entityName,
    type: l.type,
    description: l.description
  }));

  return { availableClasses, existingWorldState, existingLore };
};

const formatOperations = (ops: ArchitectOperation[]): string => {
  return ops
    .map((op, i) => {
      const opStr = JSON.stringify(op, null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `  ${i + 1}. ${opStr}`;
    })
    .join("\n");
};

// ---------------------------------------------------------------------------
// Main REPL
// ---------------------------------------------------------------------------

export const runArchitectCli = async (args: string[]): Promise<void> => {
  // Parse args: --campaign <id> [--module <path>] [--apply]
  let campaignId: string | undefined;
  let modulePath: string | undefined;
  let autoApply = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--campaign" && args[i + 1]) campaignId = args[++i];
    else if (args[i] === "--module" && args[i + 1]) modulePath = args[++i];
    else if (args[i] === "--apply") autoApply = true;
  }

  if (!campaignId) {
    process.stderr.write("Usage: od architect --campaign <campaignId> [--module <path>] [--apply]\n");
    process.exit(1);
  }

  const prisma = new PrismaClient();

  // Verify campaign exists
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    process.stderr.write(`Campaign not found: ${campaignId}\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const architect = new ArchitectRuntime();
  const executor = new ArchitectOperationExecutor(prisma);

  process.stdout.write(`\nArchitect Worldbuilder — Campaign: "${campaign.title}" (${campaignId})\n`);
  process.stdout.write(`Type your request, or "exit" to quit.\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const conversationHistory: WorldbuilderMessage[] = [];

  const prompt = (): void => {
    rl.question("> ", async (userInput) => {
      const trimmed = userInput.trim();
      if (!trimmed) {
        prompt();
        return;
      }
      if (trimmed === "exit" || trimmed === "quit") {
        await prisma.$disconnect();
        rl.close();
        return;
      }

      try {
        const moduleContext = await loadModuleContext(modulePath, prisma, campaignId!);

        const result: WorldbuilderTurnResult = await architect.runWorldbuilderTurn({
          conversationHistory,
          userMessage: trimmed,
          moduleContext
        });

        process.stdout.write(`\nArchitect: ${result.assistantMessage}\n`);

        conversationHistory.push({ role: "user", content: trimmed });
        conversationHistory.push({ role: "assistant", content: result.assistantMessage });

        if (result.pendingOperations.length === 0) {
          process.stdout.write("\n");
          prompt();
          return;
        }

        process.stdout.write(`\nPending operations (${result.pendingOperations.length}):\n`);
        process.stdout.write(formatOperations(result.pendingOperations));
        process.stdout.write("\n");

        if (autoApply) {
          const report = await executor.execute(result.pendingOperations, campaignId!);
          process.stdout.write(`Applied: ${report.applied} operations\n`);
          if (report.errors.length > 0) {
            for (const e of report.errors) {
              process.stderr.write(`  Error: ${e.reason}\n`);
            }
          }
          process.stdout.write("\n");
          prompt();
        } else {
          rl.question("Apply these operations? [y/N] ", async (answer) => {
            if (answer.trim().toLowerCase() === "y") {
              const report = await executor.execute(result.pendingOperations, campaignId!);
              process.stdout.write(`Applied: ${report.applied} operations\n`);
              if (report.errors.length > 0) {
                for (const e of report.errors) {
                  process.stderr.write(`  Error: ${e.reason}\n`);
                }
              }
            } else {
              process.stdout.write("Skipped.\n");
            }
            process.stdout.write("\n");
            prompt();
          });
        }
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        prompt();
      }
    });
  };

  prompt();
};
