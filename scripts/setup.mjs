import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import os from "node:os";
import net from "node:net";
import readline from "node:readline/promises";

const rootDir = process.cwd();
const envExamplePath = resolve(rootDir, ".env.example");
const envLocalPath = resolve(rootDir, ".env.local");

const askModuleType = async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\n" + "-".repeat(40) + "\n");
    process.stdout.write("Welcome to OpenDungeon! Let's choose your starting point.\n\n");
    process.stdout.write("1) Start with 'game-example' (A pre-built module with logic and AI skills)\n");
    process.stdout.write("2) Create a clean project (A fresh start for your own ideas)\n\n");

    let choice = "";
    while (!["1", "2"].includes(choice)) {
      choice = (await rl.question("Your choice [1/2]: ")).trim();
    }

    if (choice === "1") {
      const name = (await rl.question("\nEnter your game folder name [default: game-my-adventure]: ")).trim() || "game-my-adventure";
      return { type: "example", name };
    } else {
      const name = (await rl.question("\nEnter your game folder name [e.g. game-legend-of-shadows]: ")).trim();
      const finalName = name || "game-new-adventure";
      return { type: "new", name: finalName };
    }
  } finally {
    rl.close();
  }
};

const askWebModuleName = async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\n" + "-".repeat(40) + "\n");
    process.stdout.write("Web UI Setup\n\n");
    const name = (await rl.question("Enter your web module folder name [default: game-default]: ")).trim() || "game-default";
    return name;
  } finally {
    rl.close();
  }
};

const getLocalIp = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
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

const findAvailablePort = async (startPort, skip = []) => {
  let port = startPort;
  while (await checkPortInUse(port) || skip.includes(port)) {
    port += 1;
  }
  return port;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
};

const hasCommand = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
};

const canReachDockerDaemon = () => {
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.status === 0;
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

const waitForDb = () => {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["compose", "exec", "-T", "db", "pg_isready", "-U", "od", "-d", "opendungeon"],
      { stdio: "ignore" }
    );

    if (result.status === 0) {
      return;
    }

    spawnSync("node", ["-e", "setTimeout(() => process.exit(0), 1000)"]);
  }

  throw new Error("Database did not become ready in time");
};

const readEnvLocal = () => {
  const envPath = resolve(rootDir, ".env.local");
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
  writeFileSync(resolve(rootDir, ".env.local"), out, "utf8");
};

const WEB_COPY_SKIP = new Set(["node_modules", ".turbo", "dist", "tsconfig.tsbuildinfo"]);

const shouldCopyWebPath = (src) => {
  const normalized = src.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (const part of parts) {
    if (WEB_COPY_SKIP.has(part)) return false;
  }
  return true;
};

const parseSetupArgs = (argv) => {
  const mode = {
    webOnly: false,
    gameOnly: false,
    full: true
  };

  for (const arg of argv) {
    if (arg === "--web-only") {
      mode.webOnly = true;
      mode.full = false;
    }
    if (arg === "--game-only") {
      mode.gameOnly = true;
      mode.full = false;
    }
  }

  return mode;
};

const main = async () => {
  const setupMode = parseSetupArgs(process.argv.slice(2));

  if (!hasCommand("docker")) {
    throw new Error("Docker is required for setup. Install Docker Desktop or Docker Engine first.");
  }

  if (!hasCommand("docker", ["compose", "version"])) {
    throw new Error("Docker Compose plugin is required. Install docker compose support.");
  }

  if (!canReachDockerDaemon()) {
    throw new Error(
      "Docker daemon is not running. Start Docker Desktop or run 'sudo systemctl start docker' and retry."
    );
  }

  const localIp = getLocalIp();
  const currentEnv = parseEnvFile(envLocalPath);
  const exampleEnv = parseEnvFile(envExamplePath);

  // ASK FOR GAME MODULE CHOICE (skip if web-only mode)
  let moduleChoice = null;
  if (!setupMode.webOnly) {
    moduleChoice = await askModuleType();
  }

  // Determine module names
  const gameModuleDir = moduleChoice
    ? (moduleChoice.name.startsWith("game-") ? moduleChoice.name : `game-${moduleChoice.name}`)
    : null;
  const gameModulePath = gameModuleDir ? resolve(rootDir, "games", gameModuleDir) : null;

  // For web-only mode, ask for module name or use existing from env
  let webModuleDir = gameModuleDir;
  if (setupMode.webOnly) {
    const webName = await askWebModuleName();
    webModuleDir = webName.startsWith("game-") ? webName : `game-${webName}`;
  }

  if (!existsSync(resolve(rootDir, "games"))) {
    mkdirSync(resolve(rootDir, "games"), { recursive: true });
  }

  // GAME MODULE SETUP (skip if web-only mode)
  if (!setupMode.webOnly && gameModulePath) {
    if (!existsSync(gameModulePath)) {
      if (moduleChoice.type === "example") {
        process.stdout.write(`\nCopying example module to ./games/${gameModuleDir}...\n`);
        cpSync(resolve(rootDir, "packages", "game-example"), gameModulePath, {
          recursive: true,
          filter: (src) => {
            const normalized = src.replace(/\\/g, "/");
            if (normalized.includes("/.turbo/")) return false;
            if (normalized.includes("/node_modules/")) return false;
            if (normalized.includes("/dist/")) return false;
            return true;
          }
        });
      } else {
        process.stdout.write(`\nGenerating new module in ./games/${gameModuleDir}...\n`);
        run("node", [resolve(rootDir, "scripts", "create-game-module.mjs"), `games/${gameModuleDir}`, "--name", `@opendungeon/${moduleChoice.name}`, "--no-web"]);
      }
    } else {
      process.stdout.write(`\nFolder ./games/${gameModuleDir} already exists. Using it.\n`);
    }

    // Update env with game module path
    const { lines: currentLines, map: currentMap } = readEnvLocal();
    currentMap.set("GAME_MODULE_PATH", `./games/${gameModuleDir}`);
    writeEnvLocal(currentLines, currentMap);
    process.stdout.write(`Updated .env.local: GAME_MODULE_PATH=./games/${gameModuleDir}\n`);
  }

  // WEB UI SETUP (skip if game-only mode)
  if (!setupMode.gameOnly) {
    const webModulePath = resolve(rootDir, "web", webModuleDir);
    const defaultUiPath = resolve(rootDir, "apps/web");
    let webModuleCreated = false;
    let webModuleUpgraded = false;

    if (!existsSync(webModulePath) && existsSync(defaultUiPath)) {
      process.stdout.write(`\nScaffolding web UI module to ./web/${webModuleDir}...\n`);
      mkdirSync(webModulePath, { recursive: true });
      cpSync(defaultUiPath, webModulePath, { recursive: true, filter: shouldCopyWebPath });
      webModuleCreated = true;
    } else if (existsSync(webModulePath)) {
      process.stdout.write(`\nFolder ./web/${webModuleDir} already exists. Using it.\n`);
      const webPackageJsonPath = resolve(webModulePath, "package.json");
      if (!existsSync(webPackageJsonPath) && existsSync(defaultUiPath)) {
        process.stdout.write(`Upgrading legacy web module scaffold in ./web/${webModuleDir}...\n`);
        cpSync(defaultUiPath, webModulePath, { recursive: true, filter: shouldCopyWebPath });
        webModuleUpgraded = true;
      }
    }

    const webPackageJsonPath = resolve(webModulePath, "package.json");
    const webNodeModulesPath = resolve(webModulePath, "node_modules");
    const shouldInstallWebDeps =
      existsSync(webPackageJsonPath) && (webModuleCreated || webModuleUpgraded || !existsSync(webNodeModulesPath));
    if (shouldInstallWebDeps) {
      process.stdout.write(`Installing web UI dependencies in ./web/${webModuleDir}...\n`);
      run("pnpm", ["install", "--ignore-workspace"], { cwd: webModulePath });
    }

    // Update env with web module path
    const { lines: currentLines, map: currentMap } = readEnvLocal();
    currentMap.set("WEB_MODULE_PATH", `./web/${webModuleDir}`);
    writeEnvLocal(currentLines, currentMap);
    process.stdout.write(`Updated .env.local: WEB_MODULE_PATH=./web/${webModuleDir}\n`);
  }

  // DATABASE SETUP (skip if game-only or web-only mode - only run for full setup)
  if (setupMode.full) {
    // Re-read env after module setup to get updated GAME_MODULE_PATH and WEB_MODULE_PATH
    const { map: updatedMap } = readEnvLocal();
    const updatedEnv = Object.fromEntries(updatedMap.entries());

    // Determine ideal ports
    const webPort = await findAvailablePort(Number(currentEnv.WEB_PORT || exampleEnv.WEB_PORT || 3000));
    const gatewayPort = await findAvailablePort(Number(currentEnv.GATEWAY_PORT || exampleEnv.GATEWAY_PORT || 3001), [webPort]);

    const config = {
      ...exampleEnv, // Start with defaults
      ...currentEnv, // Overlay existing user keys (API keys, etc.)
      ...updatedEnv, // Include GAME_MODULE_PATH and WEB_MODULE_PATH set by module setup above
      // Force override infrastructural keys
      DATABASE_URL: currentEnv.DATABASE_URL || exampleEnv.DATABASE_URL,
      WEB_PORT: webPort.toString(),
      GATEWAY_PORT: gatewayPort.toString(),
      NEXT_PUBLIC_GATEWAY_URL: `http://${localIp}:${gatewayPort}`,
      // Performance settings (preserve existing or use defaults)
      ENABLE_ARCHIVIST: currentEnv.ENABLE_ARCHIVIST ?? exampleEnv.ENABLE_ARCHIVIST ?? "true",
      ENABLE_TRACE_LOGS: currentEnv.ENABLE_TRACE_LOGS ?? exampleEnv.ENABLE_TRACE_LOGS ?? "false",
      ENABLE_TURN_TRACE: currentEnv.ENABLE_TURN_TRACE ?? exampleEnv.ENABLE_TURN_TRACE ?? "false",
      ENABLE_BACKGROUND_TRACE: currentEnv.ENABLE_BACKGROUND_TRACE ?? exampleEnv.ENABLE_BACKGROUND_TRACE ?? "false",
      TURN_TRACE_LOG_FILE: currentEnv.TURN_TRACE_LOG_FILE ?? exampleEnv.TURN_TRACE_LOG_FILE ?? "logs/turn-traces.jsonl",
      BACKGROUND_TRACE_LOG_FILE: currentEnv.BACKGROUND_TRACE_LOG_FILE ?? exampleEnv.BACKGROUND_TRACE_LOG_FILE ?? "logs/background-traces.jsonl",
      DM_CONTEXT_ROUTER_FORCE_LLM: currentEnv.DM_CONTEXT_ROUTER_FORCE_LLM ?? exampleEnv.DM_CONTEXT_ROUTER_FORCE_LLM ?? "false",
      GATEWAY_LLM_RPM: currentEnv.GATEWAY_LLM_RPM ?? exampleEnv.GATEWAY_LLM_RPM ?? "60",
      GATEWAY_LLM_MAX_CONCURRENT: currentEnv.GATEWAY_LLM_MAX_CONCURRENT ?? exampleEnv.GATEWAY_LLM_MAX_CONCURRENT ?? "5",
      LLM_ROUTER_PROVIDER: currentEnv.LLM_ROUTER_PROVIDER ?? exampleEnv.LLM_ROUTER_PROVIDER ?? "",
      LLM_ROUTER_BASE_URL: currentEnv.LLM_ROUTER_BASE_URL ?? exampleEnv.LLM_ROUTER_BASE_URL ?? "",
      LLM_ROUTER_API_KEY: currentEnv.LLM_ROUTER_API_KEY ?? exampleEnv.LLM_ROUTER_API_KEY ?? "",
      LLM_ROUTER_MODEL: currentEnv.LLM_ROUTER_MODEL ?? exampleEnv.LLM_ROUTER_MODEL ?? "",
      LLM_ROUTER_ENDPOINT_PATH: currentEnv.LLM_ROUTER_ENDPOINT_PATH ?? exampleEnv.LLM_ROUTER_ENDPOINT_PATH ?? "",
      LLM_ROUTER_ANTHROPIC_VERSION: currentEnv.LLM_ROUTER_ANTHROPIC_VERSION ?? exampleEnv.LLM_ROUTER_ANTHROPIC_VERSION ?? "",
      LLM_ROUTER_EXTRA_HEADERS_JSON: currentEnv.LLM_ROUTER_EXTRA_HEADERS_JSON ?? exampleEnv.LLM_ROUTER_EXTRA_HEADERS_JSON ?? "",
    };

    const { lines, map } = readEnvLocal();
    for (const [key, value] of Object.entries(config)) {
      map.set(key, value);
    }
    writeEnvLocal(lines, map);
    process.stdout.write(`Updated .env.local: Web on ${webPort}, Gateway on ${gatewayPort}, IP: ${localIp}\n`);

    run("docker", ["compose", "up", "-d", "db"]);
    waitForDb();

    const envFromFile = parseEnvFile(envLocalPath);
    const mergedEnv = { ...process.env, ...envFromFile };

    run("pnpm", ["run", "db:generate"], { env: mergedEnv });
    run("pnpm", ["run", "db:push"], { env: mergedEnv });

    process.stdout.write("\n" + "-".repeat(40) + "\n");
    process.stdout.write(`SUCCESS! Your game is ready in: ./games/${gameModuleDir}\n`);
    process.stdout.write(`Web UI ready in:                ./web/${webModuleDir}\n\n`);
    process.stdout.write(`Next: od start\n`);
    process.stdout.write("-".repeat(40) + "\n\n");
  } else {
    // Partial setup summary
    process.stdout.write("\n" + "-".repeat(40) + "\n");
    if (setupMode.webOnly) {
      process.stdout.write(`SUCCESS! Web UI module ready in: ./web/${webModuleDir}\n`);
    } else if (setupMode.gameOnly) {
      process.stdout.write(`SUCCESS! Game module ready in: ./games/${gameModuleDir}\n`);
    }
    process.stdout.write("-".repeat(40) + "\n\n");
  }
};

await main();
