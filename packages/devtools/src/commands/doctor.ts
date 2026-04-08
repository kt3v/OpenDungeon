import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { printInfo, printSuccess, printWarning, printError, printLine } from "../lib/output.js";
import { findProjectRoot } from "../lib/project-root.js";
import { readEnvLocal, writeEnvLocal, setEnvValue, getEnvValue, type EnvMap } from "../lib/env-reader.js";

interface EnvDefinition {
  required: boolean;
  default: string;
  section: string;
  description?: string;
  sensitive?: boolean;
}

const ENV_DEFINITIONS: Record<string, EnvDefinition> = {
  // Required core vars
  DATABASE_URL: { required: true, default: "postgresql://od:odpass@localhost:5432/opendungeon", section: "Core" },
  GAME_MODULE_PATH: { required: true, default: "./games/game-example", section: "Core" },
  WEB_MODULE_PATH: { required: true, default: "./web/game-default", section: "Core" },
  WEB_PORT: { required: true, default: "3000", section: "Core" },
  GATEWAY_PORT: { required: true, default: "3001", section: "Core" },
  NEXT_PUBLIC_GATEWAY_URL: { required: true, default: "http://localhost:3001", section: "Core" },

  // LLM Provider vars
  LLM_PROVIDER: { required: false, default: "mock", section: "LLM" },
  LLM_BASE_URL: { required: false, default: "", section: "LLM" },
  LLM_API_KEY: { required: false, default: "", section: "LLM", sensitive: true },
  LLM_MODEL: { required: false, default: "", section: "LLM" },

  // Performance vars
  ENABLE_ARCHIVIST: {
    required: false,
    default: "true",
    section: "Performance",
    description: "Extra LLM call for world state normalization (slower)"
  },
  GATEWAY_LLM_RPM: { 
    required: false, 
    default: "60", 
    section: "Performance", 
    description: "Rate limit: requests per minute" 
  },
  GATEWAY_LLM_MAX_CONCURRENT: { 
    required: false, 
    default: "5", 
    section: "Performance", 
    description: "Max parallel requests per provider" 
  },
  GATEWAY_LLM_RPM_WINDOW_MS: { 
    required: false, 
    default: "60000", 
    section: "Performance", 
    description: "Rate limit window in ms" 
  },

  // Optional fallback vars
  GATEWAY_LLM_FALLBACK_PROVIDER: { required: false, default: "", section: "Fallback" },
  GATEWAY_LLM_FALLBACK_BASE_URL: { required: false, default: "", section: "Fallback" },
  GATEWAY_LLM_FALLBACK_API_KEY: { required: false, default: "", section: "Fallback", sensitive: true },
  GATEWAY_LLM_FALLBACK_MODEL: { required: false, default: "", section: "Fallback" },
  GATEWAY_LLM_FALLBACK_RPM: { required: false, default: "", section: "Fallback" },
};

const parseEnvFile = (filePath: string): Record<string, string> => {
  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const env: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    env[key] = value;
  }

  return env;
};

export const runDoctor = async (args: string[]): Promise<void> => {
  const rootDir = findProjectRoot();
  const fix = args.includes("--fix") || args.includes("-f");
  const subcommand = args[0];

  // Check if running as subcommand "env"
  if (subcommand === "env") {
    await checkEnv(rootDir, fix);
    return;
  }

  // Otherwise show usage
  printLine();
  printInfo("od doctor", "Check project health and configuration");
  printLine();
  console.log("Usage:");
  console.log("  od doctor env          Check environment variables");
  console.log("  od doctor env --fix    Add missing env vars with defaults");
  console.log();
};

const checkEnv = async (rootDir: string, fix: boolean): Promise<void> => {
  const envPath = resolve(rootDir, ".env.local");
  const exampleEnvPath = resolve(rootDir, ".env.example");

  const localEnv = existsSync(envPath) ? parseEnvFile(envPath) : {};
  const exampleEnv = existsSync(exampleEnvPath) ? parseEnvFile(exampleEnvPath) : {};
  const envState = readEnvLocal(rootDir);

  // Track what we added
  const added: string[] = [];
  let hasErrors = false;

  printLine();
  printInfo("od doctor env", "Checking environment variables");
  printLine();

  let currentSection = "";
  for (const [key, def] of Object.entries(ENV_DEFINITIONS)) {
    // Print section header
    if (def.section !== currentSection) {
      currentSection = def.section;
      console.log(`\n[${currentSection}]`);
    }

    const currentValue = localEnv[key];
    const exampleValue = exampleEnv[key] ?? def.default;
    const hasValue = currentValue !== undefined && currentValue !== "";

    if (def.required && !hasValue) {
      if (fix) {
        setEnvValue(envState, key, exampleValue);
        added.push(key);
        printWarning(`${key.padEnd(30)} MISSING → added with default`);
      } else {
        printError(`${key.padEnd(30)} MISSING - run with --fix to add defaults`);
        hasErrors = true;
      }
    } else if (!hasValue && exampleValue) {
      // Optional var with default available
      if (fix) {
        setEnvValue(envState, key, exampleValue);
        added.push(key);
        printWarning(`${key.padEnd(30)} empty → set to default: ${exampleValue}`);
      } else {
        printWarning(`${key.padEnd(30)} empty (default: ${exampleValue})`);
      }
    } else if (hasValue) {
      const displayValue = def.sensitive ? "***" : currentValue;
      const isDefault = currentValue === exampleValue && def.default !== "";
      const status = isDefault ? " (default)" : "";
      if (def.description) {
        printSuccess(`${key.padEnd(30)} ${displayValue}${status}`);
        console.log(`                              ${def.description}`);
      } else {
        printSuccess(`${key.padEnd(30)} ${displayValue}${status}`);
      }
    } else {
      console.log(`  ${key.padEnd(28)} not set (optional)`);
    }
  }

  // Check for orphaned vars (in local but not in definitions)
  const definedKeys = new Set(Object.keys(ENV_DEFINITIONS));
  const orphaned = Object.keys(localEnv).filter(k => !definedKeys.has(k) && !k.startsWith("#"));
  if (orphaned.length > 0) {
    console.log("\n[Unknown Variables - May be custom or obsolete]");
    for (const key of orphaned) {
      console.log(`  ${key.padEnd(28)} ${localEnv[key]}`);
    }
  }

  // Write changes if fixing
  if (fix && added.length > 0) {
    writeEnvLocal(rootDir, envState);
    printLine();
    printSuccess(`Updated .env.local with ${added.length} new variable(s)`);
    console.log("\nAdded:");
    for (const key of added) {
      console.log(`  + ${key}`);
    }
  }

  printLine();

  if (hasErrors) {
    printError("Some required environment variables are missing.");
    console.log("Run 'od doctor env --fix' to add missing defaults.");
    process.exit(1);
  }

  if (!fix && added.length === 0) {
    printSuccess("All environment variables are configured correctly!");
  }
};
