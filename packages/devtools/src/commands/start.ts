import { findProjectRoot, getProjectId } from "../lib/project-root.js";
import {
  startService,
  getServiceState,
  type ServiceName,
} from "../lib/process-manager.js";
import { readEnvLocal, getEnvValue } from "../lib/env-reader.js";
import { println, printError, color, c, sym } from "../lib/output.js";

const VALID_SERVICES = ["full", "gateway", "web"] as const;

export async function runStart(args: string[]): Promise<void> {
  const target = (args[0] ?? "full") as string;

  if (!VALID_SERVICES.includes(target as (typeof VALID_SERVICES)[number])) {
    printError(`Unknown service: ${target}`);
    println("Usage: od start [full|gateway|web]");
    process.exit(1);
  }

  const root = findProjectRoot();
  const projectId = getProjectId(root);
  const services: ServiceName[] =
    target === "full" ? ["gateway", "web"] : [target as ServiceName];

  println();
  for (const service of services) {
    const state = getServiceState(projectId, service);
    if (state.alive) {
      println(
        color(`${sym.warn} ${service} is already running`, c.yellow) +
          color(` (pid ${state.pid})`, c.dim)
      );
      continue;
    }

    process.stdout.write(`  Starting ${service}...`);
    const { pid, logPath } = await startService(root, projectId, service);
    process.stdout.write(
      `\r  ${color(`${sym.ok} ${service} started`, c.green)}` +
        color(` (pid ${pid})`, c.dim) +
        "\n"
    );
    println(color(`    Logs: od logs ${service}`, c.dim) + color(`  (file: ${logPath})`, c.dim));
  }

  println();
  printUrls(root);
  println();
  println(color("  Run `od stop` to shut everything down.", c.dim));
  println();
}

function printUrls(projectRoot: string): void {
  const env = readEnvLocal(projectRoot);
  const webPort = getEnvValue(env, "WEB_PORT") ?? "3000";
  const gatewayPort = getEnvValue(env, "GATEWAY_PORT") ?? "3001";
  println(
    color("  Web UI:  ", c.dim) + color(`http://localhost:${webPort}`, c.cyan)
  );
  println(
    color("  Gateway: ", c.dim) + color(`http://localhost:${gatewayPort}`, c.cyan)
  );
}
