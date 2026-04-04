import { spawnSync } from "node:child_process";
import net from "node:net";

const requiredNodeMajor = 22;

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

const ok = (label, value) => `OK  ${label}: ${value}`;
const warn = (label, value) => `WARN ${label}: ${value}`;
const fail = (label, value) => `FAIL ${label}: ${value}`;

const main = async () => {
  const messages = [];
  let hasHardFailures = false;

  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0] || "0");
  if (nodeMajor >= requiredNodeMajor) {
    messages.push(ok("Node", nodeVersion));
  } else {
    messages.push(fail("Node", `found ${nodeVersion}, require >= ${requiredNodeMajor}.x`));
    hasHardFailures = true;
  }

  if (hasCommand("npm")) {
    messages.push(ok("npm", getCommandOutput("npm") ?? "available"));
  } else {
    messages.push(fail("npm", "not found in PATH"));
    hasHardFailures = true;
  }

  if (hasCommand("docker")) {
    messages.push(ok("docker", getCommandOutput("docker") ?? "available"));
  } else {
    messages.push(fail("docker", "not found in PATH"));
    hasHardFailures = true;
  }

  if (hasCommand("docker") && canReachDockerDaemon()) {
    messages.push(ok("docker daemon", "running"));
  } else if (hasCommand("docker")) {
    messages.push(fail("docker daemon", "not reachable (start Docker service/app)"));
    hasHardFailures = true;
  }

  if (hasCommand("docker", ["compose", "version"])) {
    messages.push(ok("docker compose", getCommandOutput("docker", ["compose", "version"]) ?? "available"));
  } else {
    messages.push(fail("docker compose", "plugin is missing"));
    hasHardFailures = true;
  }

  // Check .env.local
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) {
    messages.push(warn(".env.local", "missing (run setup to create it)"));
  } else {
    const envContent = readFileSync(envPath, "utf8");
    const requiredKeys = ["DATABASE_URL", "GAME_MODULE_PATH"];
    for (const key of requiredKeys) {
      if (!envContent.includes(`${key}=`)) {
        messages.push(fail(`.env.local: ${key}`, "missing"));
        hasHardFailures = true;
      } else {
        messages.push(ok(`.env.local: ${key}`, "present"));
      }
    }
  }

  const ports = [3000, 3001, 5432];
  for (const port of ports) {
    const busy = await checkPortInUse(port);
    if (busy) {
      messages.push(warn(`port ${port}`, "already in use"));
    } else {
      messages.push(ok(`port ${port}`, "available"));
    }
  }

  process.stdout.write("OpenDungeon Doctor\n\n");
  process.stdout.write(messages.join("\n"));
  process.stdout.write("\n");

  if (hasHardFailures) {
    process.stdout.write("\nSome required dependencies are missing. Fix FAIL items and run `npm run doctor` again.\n");
    process.exit(1);
  }

  process.stdout.write("\nEnvironment looks good. Next step: npm run setup\n");
};

await main();
