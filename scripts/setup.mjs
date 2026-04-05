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

const main = async () => {
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

  // ASK FOR GAME MODULE CHOICE
  const moduleChoice = await askModuleType();
  const gameModuleDir = moduleChoice.name.startsWith("game-") ? moduleChoice.name : `game-${moduleChoice.name}`;
  const gameModulePath = resolve(rootDir, gameModuleDir);

  if (!existsSync(gameModulePath)) {
    if (moduleChoice.type === "example") {
      process.stdout.write(`\nCopying example module to ./${gameModuleDir}...\n`);
      cpSync(resolve(rootDir, "game-example"), gameModulePath, { recursive: true });
    } else {
      process.stdout.write(`\nGenerating new module in ./${gameModuleDir}...\n`);
      run("node", [resolve(rootDir, "scripts", "create-game-module.mjs"), gameModuleDir, "--name", `@opendungeon/${moduleChoice.name}`]);
    }
  } else {
    process.stdout.write(`\nFolder ./${gameModuleDir} already exists. Using it.\n`);
  }

  // Determine ideal ports
  const webPort = await findAvailablePort(Number(currentEnv.WEB_PORT || exampleEnv.WEB_PORT || 3000));
  const gatewayPort = await findAvailablePort(Number(currentEnv.GATEWAY_PORT || exampleEnv.GATEWAY_PORT || 3001), [webPort]);

  const config = {
    ...exampleEnv, // Start with defaults
    ...currentEnv, // Overlay existing user keys (API keys, etc.)
    // Force override infrastructural keys
    DATABASE_URL: currentEnv.DATABASE_URL || exampleEnv.DATABASE_URL,
    WEB_PORT: webPort.toString(),
    GATEWAY_PORT: gatewayPort.toString(),
    NEXT_PUBLIC_GATEWAY_URL: `http://${localIp}:${gatewayPort}`,
    GAME_MODULE_PATH: `./${gameModuleDir}`
  };

  const newEnvContent = Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  writeFileSync(envLocalPath, newEnvContent);
  process.stdout.write(`Updated .env.local: Web on ${webPort}, Gateway on ${gatewayPort}, IP: ${localIp}\n`);

  run("docker", ["compose", "up", "-d", "db"]);
  waitForDb();

  const envFromFile = parseEnvFile(envLocalPath);
  const mergedEnv = { ...process.env, ...envFromFile };

  run("pnpm", ["run", "db:generate"], { env: mergedEnv });
  run("pnpm", ["run", "db:push"], { env: mergedEnv });

  process.stdout.write("\n" + "-".repeat(40) + "\n");
  process.stdout.write(`SUCCESS! Your game is ready in: ./${gameModuleDir}\n`);
  process.stdout.write("Next: od start\n");
  process.stdout.write("-".repeat(40) + "\n\n");
};

await main();
