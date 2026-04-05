/**
 * od architect analyze
 *
 * Reads unhandled intent logs from the database, groups them by pattern,
 * and asks the Architect LLM to suggest new SkillSchema definitions.
 *
 * Usage:
 *   od architect analyze --campaign <id> [--since <ISO date>] [--min-count <n>] [--output <dir>] [--all]
 */

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PrismaClient } from "@prisma/client";
import { SkillSuggestionRuntime, type IntentPattern } from "@opendungeon/architect";
import type { SkillSchema } from "@opendungeon/content-sdk";
import { color, c, sym, println, printError, printHeader } from "./lib/output.js";

interface AnalyzeArgs {
  campaignId: string;
  since?: Date;
  minCount: number;
  outputDir: string;
  saveAll: boolean;
}

export async function runArchitectAnalyze(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    println("Usage: od architect analyze --campaign <id> [--since <date>] [--min-count <n>] [--output <dir>] [--all]");
    println();
    println("Options:");
    println("  --campaign   Campaign ID to analyze (required)");
    println("  --since      Only include intents after this date (ISO 8601)");
    println("  --min-count  Minimum occurrences to include a pattern (default: 2)");
    println("  --output     Directory to save suggested skill files (default: ./skills/suggested)");
    println("  --all        Save all suggestions without prompting");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    printError("DATABASE_URL is not set. Run 'od setup' first.");
    process.exit(1);
  }

  printHeader(`Architect Analyze — campaign ${args.campaignId}`);

  // 1. Fetch unhandled intents from EventLog
  println(color("Fetching unhandled intents from logs...", c.dim));
  const prisma = new PrismaClient();

  let patterns: IntentPattern[];
  try {
    patterns = await fetchIntentPatterns(prisma, args);
  } finally {
    await prisma.$disconnect();
  }

  if (patterns.length === 0) {
    println(color(`${sym.ok} No unhandled intents found matching the filters.`, c.green));
    println();
    println(color("Tip: lower --min-count or remove --since to broaden the search.", c.dim));
    return;
  }

  println(color(`Found ${patterns.length} intent pattern(s).`, c.cyan));
  println();

  // 2. Ask Architect LLM to suggest skills
  println(color("Asking Architect to generate skill suggestions...", c.dim));
  const suggester = new SkillSuggestionRuntime();

  let suggestions;
  try {
    suggestions = await suggester.suggestSkills(patterns);
  } catch (err) {
    printError(`Architect failed: ${String(err)}`);
    process.exit(1);
  }

  if (suggestions.length === 0) {
    println(color(`${sym.warn} Architect found no meaningful patterns to suggest skills for.`, c.yellow));
    return;
  }

  println(color(`${sym.ok} ${suggestions.length} skill suggestion(s) ready.`, c.green));
  println();

  // 3. Show suggestions and optionally save
  mkdirSync(resolve(args.outputDir), { recursive: true });

  for (const suggestion of suggestions) {
    println(color("─".repeat(60), c.dim));
    println(color(`Pattern: `, c.bold) + suggestion.pattern);
    println(color(`Occurrences: `, c.dim) + String(suggestion.occurrences));
    println();
    println(color(`Suggested skill:`, c.cyan));
    println(JSON.stringify(suggestion.skill, null, 2));
    println();

    const fileName = `${suggestion.skill.id}.json`;
    const filePath = join(resolve(args.outputDir), fileName);

    if (args.saveAll) {
      saveSkill(filePath, suggestion.skill);
      println(color(`${sym.ok} Saved to ${filePath}`, c.green));
    } else {
      const save = await prompt(`Save as ${color(filePath, c.cyan)}? [y/N] `);
      if (save.toLowerCase() === "y") {
        saveSkill(filePath, suggestion.skill);
        println(color(`${sym.ok} Saved.`, c.green));
      } else {
        println(color("Skipped.", c.dim));
      }
    }
    println();
  }

  println(color("─".repeat(60), c.dim));
  println();
  println(color("Done. ", c.bold) + `Review saved files in ${color(args.outputDir, c.cyan)}`);
  println(color("Move them to your game's skills/ directory to activate.", c.dim));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchIntentPatterns(
  prisma: PrismaClient,
  args: AnalyzeArgs
): Promise<IntentPattern[]> {
  const rows = await prisma.eventLog.findMany({
    where: {
      campaignId: args.campaignId,
      type: "intent.unhandled",
      ...(args.since ? { createdAt: { gte: args.since } } : {})
    },
    select: { payload: true },
    orderBy: { createdAt: "desc" },
    take: 500 // cap to avoid huge LLM prompts
  });

  // Group by action text (case-insensitive, trimmed)
  const counts = new Map<string, number>();
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const text = typeof payload.actionText === "string" ? payload.actionText.trim().toLowerCase() : null;
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count >= args.minCount)
    .sort(([, a], [, b]) => b - a)
    .map(([sample, occurrences]) => ({ sample, occurrences }));
}

function saveSkill(filePath: string, skill: SkillSchema): void {
  writeFileSync(filePath, JSON.stringify(skill, null, 2) + "\n", "utf8");
}

function parseArgs(argv: string[]): AnalyzeArgs | null {
  const args: Partial<AnalyzeArgs> = { minCount: 2, outputDir: "./skills/suggested", saveAll: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--campaign" && next) { args.campaignId = next; i++; }
    else if (flag === "--since" && next) { args.since = new Date(next); i++; }
    else if (flag === "--min-count" && next) { args.minCount = parseInt(next, 10); i++; }
    else if (flag === "--output" && next) { args.outputDir = next; i++; }
    else if (flag === "--all") { args.saveAll = true; }
  }

  if (!args.campaignId) return null;
  return args as AnalyzeArgs;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
