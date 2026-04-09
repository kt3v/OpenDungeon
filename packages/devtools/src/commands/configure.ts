import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { findProjectRoot } from "../lib/project-root.js";
import {
  readEnvLocal,
  writeEnvLocal,
  getEnvValue,
  setEnvValue,
} from "../lib/env-reader.js";
import { println, printError, color, c, sym } from "../lib/output.js";

export async function runConfigure(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    println();
    println("Usage: od configure [llm|ports|module]");
    println();
    println("  " + color("llm", c.bold) + "     Configure AI provider (API key, model, base URL)");
    println("  " + color("ports", c.bold) + "   Change web and gateway port numbers");
    println("  " + color("module", c.bold) + "  Set the game module path");
    println();
    process.exit(1);
  }

  const root = findProjectRoot();

  switch (subcommand) {
    case "llm":
      return runConfigureLlm(root);
    case "ports":
      return runConfigurePorts(root);
    case "module":
      return runConfigureModule(root);
    default:
      printError(`Unknown configure target: ${subcommand}`);
      println("Valid options: llm, ports, module");
      process.exit(1);
  }
}

function runConfigureLlm(root: string): void {
  const result = spawnSync("node", [join(root, "scripts", "llm-setup.mjs")], {
    stdio: "inherit",
    cwd: root,
  });
  if (result.status !== 0) {
    printError("LLM configuration failed.");
    process.exit(1);
  }
}

async function runConfigurePorts(root: string): Promise<void> {
  const envState = readEnvLocal(root);
  const currentWeb = getEnvValue(envState, "WEB_PORT") ?? "3000";
  const currentGateway = getEnvValue(envState, "GATEWAY_PORT") ?? "3001";

  println();
  println(color("Current ports:", c.bold));
  println(`  Web UI:  ${currentWeb}`);
  println(`  Gateway: ${currentGateway}`);
  println();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rawWeb = await rl.question(`Web UI port [${currentWeb}]: `);
    const newWeb = rawWeb.trim() || currentWeb;

    const rawGateway = await rl.question(`Gateway port [${currentGateway}]: `);
    const newGateway = rawGateway.trim() || currentGateway;

    for (const [label, val] of [["Web", newWeb], ["Gateway", newGateway]] as const) {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        printError(`Invalid ${label} port: ${val} (must be 1024–65535)`);
        process.exit(1);
      }
    }

    const localIp = getLocalIp();
    setEnvValue(envState, "WEB_PORT", newWeb);
    setEnvValue(envState, "GATEWAY_PORT", newGateway);
    setEnvValue(envState, "VITE_GATEWAY_URL", `http://${localIp}:${newGateway}`);
    writeEnvLocal(root, envState);

    println();
    println(color(`${sym.ok} Ports updated: Web=${newWeb}, Gateway=${newGateway}`, c.green));
    println(color("  Restart services: od stop && od start", c.dim));
    println();
  } finally {
    rl.close();
  }
}

async function runConfigureModule(root: string): Promise<void> {
  const envState = readEnvLocal(root);
  const current = getEnvValue(envState, "GAME_MODULE_PATH") ?? "";

  println();
  println(color("Game module path", c.bold));
  println(color("  This is the path to your game module directory.", c.dim));
  println(color("  Example: ./packages/game-classic", c.dim));
  println();
  if (current) {
    println(color(`  Current: ${current}`, c.dim));
  }
  println();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const prompt = current
      ? `Module path [${current}]: `
      : "Module path: ";
    const input = (await rl.question(prompt)).trim();
    const value = input || current;

    if (!value) {
      printError("Path is required.");
      process.exit(1);
    }

    const resolved = resolve(root, value);
    if (!existsSync(resolved)) {
      printError(`Path does not exist: ${resolved}`);
      process.exit(1);
    }

    setEnvValue(envState, "GAME_MODULE_PATH", value);
    writeEnvLocal(root, envState);

    println();
    println(color(`${sym.ok} GAME_MODULE_PATH set to: ${value}`, c.green));
    println(color("  Restart services: od stop && od start", c.dim));
    println();
  } finally {
    rl.close();
  }
}

function getPreferredInterfaceName(): string | null {
  if (process.platform === "darwin") {
    const result = spawnSync("route", ["-n", "get", "default"], { encoding: "utf8" });
    const match = result.stdout.match(/interface:\s*(\S+)/);
    return match?.[1] ?? null;
  }

  if (process.platform === "linux") {
    const result = spawnSync("ip", ["route", "show", "default"], { encoding: "utf8" });
    const match = result.stdout.match(/\bdev\s+(\S+)/);
    return match?.[1] ?? null;
  }

  return null;
}

function getInterfacePriority(name: string): number {
  if (/^(en|eth|wlan|wifi|wl)/i.test(name)) return 100;
  if (/^(bridge|br-|docker|veth|tailscale|utun|tun|tap|vmnet|lo)/i.test(name)) return -100;
  return 0;
}

function getLocalIp(): string {
  const nets = networkInterfaces();
  const preferredName = getPreferredInterfaceName();

  if (preferredName) {
    for (const iface of nets[preferredName] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }

  const candidates = Object.entries(nets)
    .flatMap(([name, ifaces]) =>
      (ifaces ?? [])
        .filter((iface) => iface.family === "IPv4" && !iface.internal)
        .map((iface) => ({ name, address: iface.address }))
    )
    .sort((a, b) => getInterfacePriority(b.name) - getInterfacePriority(a.name));

  const candidate = candidates[0];
  if (candidate) {
    return candidate.address;
  }

  return "localhost";
}
