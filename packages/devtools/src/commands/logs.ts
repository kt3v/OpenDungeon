import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { findProjectRoot, getProjectId } from "../lib/project-root.js";
import { getLogPath, type ServiceName } from "../lib/process-manager.js";
import { println, printError, color, c } from "../lib/output.js";

export async function runLogs(args: string[]): Promise<void> {
  let service: ServiceName | undefined;
  let follow = false;

  for (const arg of args) {
    if (arg === "-f" || arg === "--follow") {
      follow = true;
    } else if (arg === "gateway" || arg === "web") {
      service = arg;
    } else {
      printError(`Unknown argument: ${arg}`);
      println("Usage: od logs <gateway|web> [-f]");
      process.exit(1);
    }
  }

  if (!service) {
    printError("Service is required.");
    println("Usage: od logs <gateway|web> [-f]");
    process.exit(1);
  }

  const root = findProjectRoot();
  const projectId = getProjectId(root);
  const logPath = getLogPath(projectId, service);

  if (!existsSync(logPath)) {
    println(color(`No logs yet for ${service}.`, c.dim));
    println(color(`Start it first: od start ${service}`, c.dim));
    return;
  }

  if (follow) {
    println(color(`Following ${service} logs (Ctrl+C to stop)...`, c.dim));
    println();
    const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
    process.on("SIGINT", () => {
      child.kill("SIGTERM");
    });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  } else {
    spawnSync("tail", ["-n", "100", logPath], { stdio: "inherit" });
  }
}
