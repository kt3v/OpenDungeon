export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
} as const;

export const sym = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  running: "●",
  stopped: "○",
  arrow: "→",
} as const;

export function color(text: string, ...codes: string[]): string {
  return codes.join("") + text + c.reset;
}

export function println(text = ""): void {
  process.stdout.write(text + "\n");
}

export function printError(text: string): void {
  process.stderr.write(color("Error: ", c.red, c.bold) + text + "\n");
}

export function printHeader(title: string): void {
  println(color(title, c.bold));
  println();
}

export function printHelp(): void {
  println();
  println(color("OpenDungeon Engine Manager", c.bold, c.cyan));
  println();
  println("  " + color("od setup", c.bold) + "                      First-time setup (Docker, ports, database)");
  println("  " + color("od start", c.bold) + " [full|gateway|web]   Start services in the background");
  println("  " + color("od stop", c.bold) + "  [full|gateway|web]   Stop background services");
  println("  " + color("od status", c.bold) + "                     Show what is running and where");
  println("  " + color("od logs", c.bold) + "  [gateway|web] [-f]   View service logs (use -f to follow live)");
  println("  " + color("od configure", c.bold) + " [llm|ports|module]  Change settings");
  println("  " + color("od reset", c.bold) + "                      Wipe all local data and start fresh");
  println();
  println(color("  Developer tools:", c.dim));
  println(color("  od architect --campaign <id> [--module <path>] [--apply]", c.dim));
  println(color("  od architect analyze --campaign <id> [--min-count <n>] [--output <dir>] [--all]", c.dim));
  println(color("  od create-module <target-dir> [--name @scope/name]", c.dim));
  println(color("  od validate-module <path-to-manifest.json>", c.dim));
  println();
}
