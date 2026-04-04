import { findProjectRoot, getProjectId } from "../lib/project-root.js";
import {
  stopService,
  getServiceState,
  type ServiceName,
} from "../lib/process-manager.js";
import { println, printError, color, c, sym } from "../lib/output.js";

const VALID_SERVICES = ["full", "gateway", "web"] as const;

export async function runStop(args: string[]): Promise<void> {
  const target = (args[0] ?? "full") as string;

  if (!VALID_SERVICES.includes(target as (typeof VALID_SERVICES)[number])) {
    printError(`Unknown service: ${target}`);
    println("Usage: od stop [full|gateway|web]");
    process.exit(1);
  }

  const root = findProjectRoot();
  const projectId = getProjectId(root);
  const services: ServiceName[] =
    target === "full" ? ["gateway", "web"] : [target as ServiceName];

  println();
  for (const service of services) {
    const state = getServiceState(projectId, service);
    if (!state.alive) {
      println(color(`${sym.stopped} ${service} is not running`, c.dim));
      continue;
    }

    process.stdout.write(`  Stopping ${service}...`);
    await stopService(projectId, service);
    process.stdout.write(
      `\r  ${color(`${sym.ok} ${service} stopped`, c.green)}\n`
    );
  }
  println();
}
