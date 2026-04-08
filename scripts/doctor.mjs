#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const requiredNodeMajor = 20;

const hasCommand = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
};

const canReachDockerDaemon = () => {
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.status === 0;
};

const getCommandOutput = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || result.stderr || "").trim();
};

const checkPortInUse = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });

const ok = (label, value) => `✓  ${label.padEnd(25)} ${value}`;
const warn = (label, value) => `⚠  ${label.padEnd(25)} ${value}`;
const fail = (label, value) => `✗  ${label.padEnd(25)} ${value}`;
const info = (label, value) => `ℹ  ${label.padEnd(25)} ${value}`;

const getLocalIp = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
};

const parseEnvFile = (filePath) => {
  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const env = {};

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

const readEnvLocal = () => {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return { lines: [], map: new Map() };
  const lines = readFileSync(envPath, "utf8").split("\n");
  const map = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    map.set(line.slice(0, eqIdx).trim(), line.slice(eqIdx + 1));
  }
  return { lines, map };
};

const writeEnvLocal = (lines, map) => {
  const result = [];
  const written = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { result.push(line); continue; }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) { result.push(line); continue; }
    const key = line.slice(0, eqIdx).trim();
    written.add(key);
    result.push(`${key}=${map.get(key) ?? ""}`);
  }
  for (const [key, val] of map) {
    if (!written.has(key)) result.push(`${key}=${val}`);
  }
  let out = result.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!out.endsWith("\n")) out += "\n";
  writeFileSync(resolve(process.cwd(), ".env.local"), out, "utf8");
};

// All required and optional env vars with their defaults
const ENV_DEFINITIONS = {
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
  ENABLE_ARCHIVIST: { required: false, default: "true", section: "Performance", description: "Extra LLM call for world state normalization (slower)" },
  GATEWAY_LLM_RPM: { required: false, default: "60", section: "Performance", description: "Rate limit: requests per minute" },
  GATEWAY_LLM_MAX_CONCURRENT: { required: false, default: "5", section: "Performance", description: "Max parallel requests per provider" },
  GATEWAY_LLM_RPM_WINDOW_MS: { required: false, default: "60000", section: "Performance", description: "Rate limit window in ms" },

  // Optional fallback vars
  GATEWAY_LLM_FALLBACK_PROVIDER: { required: false, default: "", section: "Fallback" },
  GATEWAY_LLM_FALLBACK_BASE_URL: { required: false, default: "", section: "Fallback" },
  GATEWAY_LLM_FALLBACK_API_KEY: { required: false, default: "", section: "Fallback", sensitive: true },
  GATEWAY_LLM_FALLBACK_MODEL: { required: false, default: "", section: "Fallback" },
  GATEWAY_LLM_FALLBACK_RPM: { required: false, default: "", section: "Fallback" },
};

const checkEnvironment = async (fix = false) => {
  const messages = [];
  let hasHardFailures = false;
  const envPath = resolve(process.cwd(), ".env.local");
  const exampleEnvPath = resolve(process.cwd(), ".env.example");

  const localEnv = existsSync(envPath) ? parseEnvFile(envPath) : {};
  const exampleEnv = existsSync(exampleEnvPath) ? parseEnvFile(exampleEnvPath) : {};
  const { lines: currentLines, map: currentMap } = readEnvLocal();

  // Track what we added
  const added = [];
  const fixed = [];

  messages.push("\n" + "=".repeat(60));
  messages.push("Environment Variables Check");
  messages.push("=".repeat(60) + "\n");

  let currentSection = "";
  for (const [key, def] of Object.entries(ENV_DEFINITIONS)) {
    // Print section header
    if (def.section !== currentSection) {
      currentSection = def.section;
      messages.push(`\n[${currentSection}]`);
    }

    const currentValue = localEnv[key];
    const exampleValue = exampleEnv[key] ?? def.default;
    const hasValue = currentValue !== undefined && currentValue !== "";

    if (def.required && !hasValue) {
      if (fix) {
        currentMap.set(key, exampleValue);
        added.push(`${key}=${exampleValue}`);
        messages.push(fail(key, `MISSING → added with default: ${exampleValue}`));
      } else {
        messages.push(fail(key, "MISSING (run with --fix to add defaults)"));
        hasHardFailures = true;
      }
    } else if (!hasValue && exampleValue) {
      // Optional var with default available
      if (fix) {
        currentMap.set(key, exampleValue);
        added.push(`${key}=${exampleValue}`);
        messages.push(warn(key, `empty → set to default: ${exampleValue}`));
      } else {
        messages.push(warn(key, `empty (default: ${exampleValue})`));
      }
    } else if (hasValue) {
      const displayValue = def.sensitive ? "***" : currentValue;
      if (currentValue === exampleValue && def.default) {
        messages.push(ok(key, `${displayValue} (default)`));
      } else {
        messages.push(ok(key, displayValue));
      }
    } else {
      messages.push(info(key, "not set (optional)"));
    }
  }

  // Check for orphaned vars (in local but not in definitions)
  const definedKeys = new Set(Object.keys(ENV_DEFINITIONS));
  const orphaned = Object.keys(localEnv).filter(k => !definedKeys.has(k) && !k.startsWith("#"));
  if (orphaned.length > 0) {
    messages.push("\n[Unknown Variables - May be custom or obsolete]");
    for (const key of orphaned) {
      messages.push(info(key, localEnv[key]));
    }
  }

  // Write changes if fixing
  if (fix && (added.length > 0 || fixed.length > 0)) {
    writeEnvLocal(currentLines, currentMap);
    messages.push("\n" + "=".repeat(60));
    messages.push(`Updated .env.local with ${added.length} new variable(s)`);
    if (added.length > 0) {
      messages.push("\nAdded:");
      for (const line of added) {
        messages.push(`  + ${line.split("=")[0]}`);
      }
    }
    messages.push("=".repeat(60));
  }

  return { messages, hasHardFailures, added };
};

const main = async () => {
  const args = process.argv.slice(2);
  const command = args[0];
  const fix = args.includes("--fix") || args.includes("-f");

  // env subcommand
  if (command === "env") {
    const { messages, hasHardFailures, added } = await checkEnvironment(fix);

    for (const msg of messages) {
      process.stdout.write(msg + "\n");
    }

    if (hasHardFailures) {
      process.stdout.write("\nSome required environment variables are missing.\n");
      process.stdout.write("Run again with --fix to add missing defaults.\n");
      process.exit(1);
    }

    if (!fix && added.length === 0) {
      process.stdout.write("\n✓ All environment variables are configured correctly!\n");
    }

    process.exit(0);
  }

  // Full system check (original behavior)
  const messages = [];
  let hasHardFailures = false;

  const localIp = getLocalIp();
  messages.push(info("Local IP", `${localIp} (use this for NEXT_PUBLIC_GATEWAY_URL if accessing from other devices)`));

  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0] || "0");
  if (nodeMajor >= requiredNodeMajor) {
    messages.push(ok("Node", `${nodeVersion} (require >= ${requiredNodeMajor}.x)`));
  } else {
    messages.push(fail("Node", `found ${nodeVersion}, require >= ${requiredNodeMajor}.x`));
    hasHardFailures = true;
  }

  if (hasCommand("pnpm")) {
    const pnpmOutput = getCommandOutput("pnpm") ?? "";
    const versionMatch = pnpmOutput.match(/(\d+\.\d+\.\d+)/);
    messages.push(ok("pnpm", versionMatch ? versionMatch[1] : "available"));
  } else {
    messages.push(fail("pnpm", "not found in PATH"));
    hasHardFailures = true;
  }

  if (hasCommand("docker")) {
    const dockerOutput = getCommandOutput("docker") ?? "";
    const versionMatch = dockerOutput.match(/(\d+\.\d+\.\d+)/);
    messages.push(ok("Docker", versionMatch ? versionMatch[1] : "available"));
  } else {
    messages.push(fail("Docker", "not found in PATH"));
    hasHardFailures = true;
  }

  if (hasCommand("docker") && canReachDockerDaemon()) {
    messages.push(ok("Docker daemon", "running"));
  } else if (hasCommand("docker")) {
    messages.push(fail("Docker daemon", "not reachable (start Docker service/app)"));
    hasHardFailures = true;
  }

  if (hasCommand("docker", ["compose", "version"])) {
    const composeOutput = getCommandOutput("docker", ["compose", "version"]) ?? "";
    const versionMatch = composeOutput.match(/(\d+\.\d+\.\d+)/);
    messages.push(ok("Docker Compose", versionMatch ? versionMatch[1] : "available"));
  } else {
    messages.push(fail("Docker Compose", "plugin is missing"));
    hasHardFailures = true;
  }

  // Check .env.local exists
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) {
    messages.push(warn(".env.local", "missing (run: pnpm setup)"));
    hasHardFailures = true;
  } else {
    messages.push(ok(".env.local", "present"));

    // Check critical env vars
    const envContent = readFileSync(envPath, "utf8");
    const criticalKeys = ["DATABASE_URL", "GAME_MODULE_PATH", "WEB_MODULE_PATH"];
    for (const key of criticalKeys) {
      const hasValue = envContent.match(new RegExp(`^${key}=.+`, "m"));
      if (!hasValue) {
        messages.push(fail(`  ${key}`, "missing"));
        hasHardFailures = true;
      }
    }
  }

  // Check ports
  const ports = [3000, 3001, 5432];
  for (const port of ports) {
    const busy = await checkPortInUse(port);
    if (busy) {
      let hint = "";
      if (port === 3000) hint = " (frontend, set WEB_PORT=3005 in .env.local)";
      if (port === 3001) hint = " (gateway, set GATEWAY_PORT=3006 in .env.local)";
      if (port === 5432) hint = " (postgres, check if another DB is running)";
      messages.push(warn(`port ${port}`, `already in use${hint}`));
    } else {
      messages.push(ok(`port ${port}`, "available"));
    }
  }

  process.stdout.write("\n" + "=".repeat(60) + "\n");
  process.stdout.write("OpenDungeon Doctor\n");
  process.stdout.write("=".repeat(60) + "\n\n");

  for (const msg of messages) {
    process.stdout.write(msg + "\n");
  }

  process.stdout.write("\n" + "=".repeat(60) + "\n");

  if (hasHardFailures) {
    process.stdout.write("Some required dependencies are missing.\n");
    process.stdout.write("Fix FAIL items above and run `pnpm doctor` again.\n");
    process.stdout.write("=".repeat(60) + "\n");
    process.exit(1);
  }

  process.stdout.write("Environment looks good!\n");
  process.stdout.write("Run `pnpm doctor env` to check environment variables.\n");
  process.stdout.write("=".repeat(60) + "\n");
};

await main();
