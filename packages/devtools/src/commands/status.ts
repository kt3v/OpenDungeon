import { spawnSync } from "node:child_process";
import { findProjectRoot, getProjectId } from "../lib/project-root.js";
import { getServiceState, type ServiceName } from "../lib/process-manager.js";
import { readEnvLocal, getEnvValue } from "../lib/env-reader.js";
import { println, printHeader, color, c, sym } from "../lib/output.js";

const SERVICES: ServiceName[] = ["gateway", "web"];

export async function runStatus(_args: string[]): Promise<void> {
  const root = findProjectRoot();
  const projectId = getProjectId(root);
  const env = readEnvLocal(root);

  printHeader("OpenDungeon Status");

  let anyRunning = false;

  for (const service of SERVICES) {
    const state = getServiceState(projectId, service);
    const port =
      service === "gateway"
        ? (getEnvValue(env, "GATEWAY_PORT") ?? "3001")
        : (getEnvValue(env, "WEB_PORT") ?? "3000");

    if (state.alive) {
      anyRunning = true;
      println(
        `  ${color(`${sym.running} ${service}`, c.green)}` +
          color(`  port ${port}`, c.dim) +
          color(`  (pid ${state.pid})`, c.dim)
      );
    } else {
      println(`  ${color(`${sym.stopped} ${service}`, c.dim)}  stopped`);
    }
  }

  // Database status via Docker
  const dockerResult = spawnSync(
    "docker",
    ["inspect", "opendungeon-db", "--format={{.State.Running}}"],
    { encoding: "utf8" }
  );
  const dbRunning = dockerResult.stdout?.trim() === "true";

  if (dbRunning) {
    println(`  ${color(`${sym.running} database`, c.green)}` + color("  (opendungeon-db)", c.dim));
  } else {
    println(
      `  ${color(`${sym.stopped} database`, c.dim)}  stopped` +
        color("  — run: docker compose up -d db", c.yellow)
    );
  }

  if (anyRunning) {
    const webPort = getEnvValue(env, "WEB_PORT") ?? "3000";
    const gatewayPort = getEnvValue(env, "GATEWAY_PORT") ?? "3001";
    println();
    println(color("  Web UI:  ", c.dim) + color(`http://localhost:${webPort}`, c.cyan));
    println(color("  Gateway: ", c.dim) + color(`http://localhost:${gatewayPort}`, c.cyan));
  }

  println();
}
