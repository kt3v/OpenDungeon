import { findProjectRoot, getProjectId } from "../lib/project-root.js";
import { readEnvLocal, getEnvValue } from "../lib/env-reader.js";
import { getServiceState, isAlive } from "../lib/process-manager.js";
import { println, printError, color, c, sym } from "../lib/output.js";

const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

export async function runDrain(_args: string[]): Promise<void> {
  const root = findProjectRoot();
  const projectId = getProjectId(root);
  const env = readEnvLocal(root);

  // ── Verify gateway is running ────────────────────────────────────────────

  const gatewayState = getServiceState(projectId, "gateway");
  if (!gatewayState.alive || gatewayState.pid === null) {
    printError("Gateway is not running. Start it first with: od start gateway");
    process.exit(1);
  }

  const port = getEnvValue(env, "GATEWAY_PORT") ?? "3001";
  const gatewayUrl = `http://localhost:${port}`;

  // ── Trigger drain via SIGUSR2 (no auth token required) ──────────────────

  println();
  println(color("Initiating graceful shutdown drain...", c.cyan));
  println();

  try {
    // Send SIGUSR2 to the process group (all processes spawned under pnpm)
    const target = process.platform === "win32" ? gatewayState.pid : -gatewayState.pid;
    process.kill(target, "SIGUSR2");
  } catch (err) {
    // Signal failed — fall back to HTTP if ADMIN_TOKEN is available
    const adminToken = getEnvValue(env, "ADMIN_TOKEN");
    if (!adminToken) {
      printError(
        `Could not signal gateway process (pid ${gatewayState.pid}): ${err instanceof Error ? err.message : String(err)}`
      );
      println(
        color(
          "  Tip: set ADMIN_TOKEN in .env.local to enable HTTP-based drain as a fallback.",
          c.dim
        )
      );
      process.exit(1);
    }

    println(color("  Signal delivery failed, falling back to HTTP drain...", c.dim));
    try {
      const res = await fetch(`${gatewayUrl}/admin/drain`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken}`,
        },
      });
      if (res.status === 401 || res.status === 403) {
        printError("Invalid ADMIN_TOKEN — cannot initiate drain via HTTP.");
        process.exit(1);
      }
      if (!res.ok) {
        printError(`Gateway returned HTTP ${res.status} when initiating drain.`);
        process.exit(1);
      }
    } catch {
      printError("Cannot reach gateway. Is it running?");
      process.exit(1);
    }
  }

  println(
    color(`  ${sym.warn} Server entered drain mode`, c.yellow) +
      color(" — new action submissions are now blocked.", c.dim)
  );
  println(
    color(
      "  Players trying to submit actions will see a friendly 'server restarting' notice.",
      c.dim
    )
  );
  println();

  // Give the gateway a moment to update its state before we start polling
  await new Promise((r) => setTimeout(r, 800));

  // ── Poll /admin/drain/status until ready ─────────────────────────────────

  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  let lastActiveCount = -1;
  let dots = 0;

  process.stdout.write("  Waiting for in-flight actions to complete");

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    // Check gateway process is still alive
    if (!isAlive(gatewayState.pid!, true)) {
      process.stdout.write("\n");
      printError("Gateway process exited unexpectedly during drain.");
      process.exit(1);
    }

    type DrainStatus = { draining: boolean; activeCount: number; ready: boolean };
    let data: DrainStatus | null = null;
    try {
      const res = await fetch(`${gatewayUrl}/admin/drain/status`);
      if (res.ok) {
        data = (await res.json()) as DrainStatus;
      }
    } catch {
      // transient fetch error — keep waiting
    }

    if (data === null) {
      process.stdout.write(".");
      dots++;
      continue;
    }

    if (!data.draining) {
      // Gateway hasn't processed the signal yet — keep waiting
      process.stdout.write(".");
      dots++;
      continue;
    }

    if (data.ready) {
      process.stdout.write("\n");
      break;
    }

    // Show count only when it changes
    if (data.activeCount !== lastActiveCount) {
      process.stdout.write(
        (dots > 0 ? "\n  Waiting for in-flight actions to complete" : "") +
          color(` (${data.activeCount} action${data.activeCount === 1 ? "" : "s"} in flight)`, c.dim)
      );
      dots = 0;
      lastActiveCount = data.activeCount;
    } else {
      process.stdout.write(".");
      dots++;
    }
  }

  if (Date.now() >= deadline) {
    process.stdout.write("\n");
    println();
    println(
      color(`${sym.warn} Drain timed out after 5 minutes.`, c.yellow)
    );
    println(
      color(
        "  Some actions may still be in flight. You can force-stop with: od stop",
        c.dim
      )
    );
    process.exit(1);
  }

  // ── Done ─────────────────────────────────────────────────────────────────

  println();
  println(color(`  ${sym.ok} All in-flight actions completed.`, c.green));
  println(color(`  ${sym.ok} Server is ready to stop.`, c.green));
  println();
  println("  Run the following to stop all services:");
  println("  " + color("od stop", c.bold, c.cyan));
  println();
}
