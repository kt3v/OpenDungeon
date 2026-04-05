import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { findProjectRoot, getProjectId } from "../lib/project-root.js";
import { getLogPath, getServiceState } from "../lib/process-manager.js";
import { println, printError, color, c } from "../lib/output.js";

export async function runRealtime(_args: string[]): Promise<void> {
  const root = findProjectRoot();
  const projectId = getProjectId(root);
  const service = "gateway";

  const state = getServiceState(projectId, service);
  const logPath = getLogPath(projectId, service);

  if (!state.alive) {
    printError(`Gateway is not running.`);
    println(color(`Start it first: od start gateway`, c.dim));
    process.exit(1);
  }

  if (!existsSync(logPath)) {
    println(color(`No logs yet for ${service}.`, c.dim));
    return;
  }

  println(color(`Realtime gateway logs (Ctrl+C to stop)...`, c.dim));
  println();

  const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });

  process.on("SIGINT", () => {
    child.kill("SIGTERM");
  });

  await new Promise<void>((resolve) => child.on("close", () => resolve()));
}
