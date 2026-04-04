import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type RawLine = { type: "raw"; value: string };
type KeyLine = { type: "key"; key: string };

export interface EnvMap {
  map: Map<string, string>;
  order: Array<RawLine | KeyLine>;
}

export function readEnvLocal(projectRoot: string): EnvMap {
  const envPath = join(projectRoot, ".env.local");
  if (!existsSync(envPath)) {
    return { map: new Map(), order: [] };
  }
  const content = readFileSync(envPath, "utf8");
  return parseEnv(content);
}

function parseEnv(content: string): EnvMap {
  const map = new Map<string, string>();
  const order: Array<RawLine | KeyLine> = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      order.push({ type: "raw", value: line });
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      order.push({ type: "raw", value: line });
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1);
    map.set(key, val);
    order.push({ type: "key", key });
  }

  return { map, order };
}

export function writeEnvLocal(projectRoot: string, state: EnvMap): void {
  writeFileSync(join(projectRoot, ".env.local"), stringifyEnv(state), "utf8");
}

export function stringifyEnv(state: EnvMap): string {
  const lines: string[] = [];
  for (const entry of state.order) {
    if (entry.type === "raw") {
      lines.push(entry.value);
    } else {
      const val = state.map.get(entry.key) ?? "";
      lines.push(`${entry.key}=${val}`);
    }
  }
  // Append keys that were added via setEnvValue but not yet in order
  for (const [key] of state.map) {
    const inOrder = state.order.some((e) => e.type === "key" && e.key === key);
    if (!inOrder) {
      lines.push(`${key}=${state.map.get(key) ?? ""}`);
    }
  }
  // Ensure single trailing newline; collapse triple+ blank lines
  let result = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

export function getEnvValue(state: EnvMap, key: string): string | undefined {
  return state.map.get(key);
}

export function setEnvValue(state: EnvMap, key: string, value: string): void {
  state.map.set(key, value);
  const inOrder = state.order.some((e) => e.type === "key" && e.key === key);
  if (!inOrder) {
    state.order.push({ type: "key", key });
  }
}
