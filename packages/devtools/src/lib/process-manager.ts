import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readEnvLocal, getEnvValue } from "./env-reader.js";

export type ServiceName = "gateway" | "web";

export interface ServiceState {
  name: ServiceName;
  pid: number | null;
  alive: boolean;
  logPath: string;
  pidPath: string;
}

function getPidsDir(projectId: string): string {
  return join(homedir(), ".od", "pids", projectId);
}

function getLogsDir(projectId: string): string {
  return join(homedir(), ".od", "logs", projectId);
}

export function getPidPath(projectId: string, service: ServiceName): string {
  return join(getPidsDir(projectId), `${service}.pid`);
}

export function getLogPath(projectId: string, service: ServiceName): string {
  return join(getLogsDir(projectId), `${service}.log`);
}

export function isAlive(pid: number, group = false): boolean {
  try {
    const target = group && process.platform !== "win32" ? -pid : pid;
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

export function getServiceState(
  projectId: string,
  service: ServiceName
): ServiceState {
  const pidPath = getPidPath(projectId, service);
  const logPath = getLogPath(projectId, service);

  if (!existsSync(pidPath)) {
    return { name: service, pid: null, alive: false, logPath, pidPath };
  }

  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);

  if (!Number.isInteger(pid) || pid <= 0) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    return { name: service, pid: null, alive: false, logPath, pidPath };
  }

  const alive = isAlive(pid, true);
  if (!alive) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    return { name: service, pid: null, alive: false, logPath, pidPath };
  }

  return { name: service, pid, alive: true, logPath, pidPath };
}

export async function startService(
  projectRoot: string,
  projectId: string,
  service: ServiceName
): Promise<{ pid: number; logPath: string }> {
  const pidsDir = getPidsDir(projectId);
  const logsDir = getLogsDir(projectId);
  mkdirSync(pidsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const pidPath = getPidPath(projectId, service);
  const logPath = getLogPath(projectId, service);

  const envState = readEnvLocal(projectRoot);
  const portKey = service === "gateway" ? "GATEWAY_PORT" : "WEB_PORT";
  const port = getEnvValue(envState, portKey) ?? (service === "gateway" ? "3001" : "3000");

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(envState.map.entries()),
    PORT: port,
  };

  if (service === "web") {
    const gatewayUrl =
      getEnvValue(envState, "VITE_GATEWAY_URL")
      ?? getEnvValue(envState, "NEXT_PUBLIC_GATEWAY_URL");
    if (gatewayUrl) {
      childEnv.VITE_GATEWAY_URL = gatewayUrl;
    }
  }

  const webModulePath = getEnvValue(envState, "WEB_MODULE_PATH");
  const resolvedWebModulePath = webModulePath ? resolve(projectRoot, webModulePath) : null;
  const hasStandaloneWebModule =
    service === "web"
    && resolvedWebModulePath !== null
    && existsSync(resolvedWebModulePath)
    && existsSync(join(resolvedWebModulePath, "package.json"));

  const commandArgs = hasStandaloneWebModule
    ? ["dev"]
    : ["--filter", `@opendungeon/${service}`, "dev"];
  const commandCwd = hasStandaloneWebModule ? resolvedWebModulePath! : projectRoot;

  const logFd = openSync(logPath, "w");

  const child = spawn(
    "pnpm",
    commandArgs,
    {
      cwd: commandCwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnv,
    }
  );

  child.unref();
  closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to get PID for ${service}`);
  }

  writeFileSync(pidPath, String(pid), "utf8");
  return { pid, logPath };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function stopService(
  projectId: string,
  service: ServiceName
): Promise<void> {
  const state = getServiceState(projectId, service);
  if (!state.alive || state.pid === null) return;

  const target = process.platform === "win32" ? state.pid : -state.pid;

  try {
    process.kill(target, "SIGTERM");
  } catch {
    /* ignore */
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isAlive(state.pid, true)) {
    await sleep(100);
  }

  if (isAlive(state.pid, true)) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* ignore */
    }
  }

  try {
    unlinkSync(state.pidPath);
  } catch {
    /* ignore */
  }
}
