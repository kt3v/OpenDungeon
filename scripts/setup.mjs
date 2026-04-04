import { copyFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const rootDir = process.cwd();
const envExamplePath = resolve(rootDir, ".env.example");
const envLocalPath = resolve(rootDir, ".env.local");

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

const main = () => {
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

  // 1. Ensure .env.local exists
  if (!existsSync(envLocalPath)) {
    if (!existsSync(envExamplePath)) {
      throw new Error(".env.example is missing");
    }
    copyFileSync(envExamplePath, envLocalPath);
    process.stdout.write("Created .env.local from .env.example\n");
  } else {
    // 2. Smart Merge: ensure required keys are present even if file exists
    const currentEnv = parseEnvFile(envLocalPath);
    const exampleEnv = parseEnvFile(envExamplePath);
    const requiredKeys = ["DATABASE_URL", "GAME_MODULE_PATH", "NEXT_PUBLIC_GATEWAY_URL", "WEB_PORT", "GATEWAY_PORT"];
    
    let addedCount = 0;
    for (const key of requiredKeys) {
      if (!currentEnv[key] && exampleEnv[key]) {
        appendFileSync(envLocalPath, `\n${key}=${exampleEnv[key]}`);
        addedCount++;
      }
    }
    
    if (addedCount > 0) {
      process.stdout.write(`Added ${addedCount} missing required keys to .env.local from .env.example\n`);
    }
  }

  run("docker", ["compose", "up", "-d", "db"]);
  waitForDb();

  const envFromFile = parseEnvFile(envLocalPath);
  const mergedEnv = { ...process.env, ...envFromFile };

  run("pnpm", ["run", "db:generate"], { env: mergedEnv });
  run("pnpm", ["run", "db:push"], { env: mergedEnv });

  process.stdout.write("\nSetup completed. Next: pnpm run dev:full\n");
};

main();
