import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DungeonMasterRuntime } from "@opendungeon/engine-core";
import { classifyProviderError, getProviderRuntimeConfigFromEnv, LlmProviderError } from "@opendungeon/providers-llm";

const loadDotEnvLocal = (): void => {
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), "../../.env.local")
  ];

  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    return;
  }

  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1);
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
};

loadDotEnvLocal();

const runtime = new DungeonMasterRuntime();

const run = async (): Promise<void> => {
  const config = getProviderRuntimeConfigFromEnv();
  process.stdout.write(`Provider: ${config.provider} | Model: ${config.model ?? "(unset)"}\n`);

  const result = await runtime.runTurn({
    campaignId: "00000000-0000-0000-0000-000000000001",
    sessionId: "00000000-0000-0000-0000-000000000002",
    campaignTitle: "Probe Campaign",
    playerId: "00000000-0000-0000-0000-000000000003",
    actionText: "look around",
    worldState: {},
    location: "dungeon_entrance",
    summary: "The party entered a forgotten dungeon.",
    recentEvents: []
  });

  process.stdout.write("LLM probe passed. Parsed DM turn result:\n");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

run().catch((error) => {
  const classified = classifyProviderError(error);
  process.stderr.write(
    `Error category: ${classified.category} | Retryable: ${classified.retryable ? "yes" : "no"}\n`
  );

  if (error instanceof LlmProviderError) {
    process.stderr.write(`LLM probe failed: ${error.message}\n`);
    if (typeof error.status === "number") {
      process.stderr.write(`HTTP status: ${error.status}\n`);
    }
    if (error.body) {
      process.stderr.write(`Provider body: ${error.body}\n`);
    }
  } else {
    process.stderr.write(`LLM probe failed: ${String(error)}\n`);
  }
  process.exit(1);
});
