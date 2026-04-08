import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const DEFAULT_TURN_TRACE_FILE = "logs/turn-traces.jsonl";
const DEFAULT_BACKGROUND_TRACE_FILE = "logs/background-traces.jsonl";

const envFlag = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
};

const resolveLogPath = (envKey: string, fallbackRelativePath: string): string => {
  const configured = process.env[envKey]?.trim();
  const rawPath = configured && configured.length > 0 ? configured : fallbackRelativePath;
  const resolutionBase = process.env.INIT_CWD && process.env.INIT_CWD.trim()
    ? process.env.INIT_CWD
    : process.cwd();
  return resolve(resolutionBase, rawPath);
};

const appendJsonLine = async (filePath: string, payload: JsonRecord): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
};

export const traceConfig = {
  enableTurnTrace: envFlag("ENABLE_TURN_TRACE", true),
  enableBackgroundTrace: envFlag("ENABLE_BACKGROUND_TRACE", true),
  turnTraceFile: resolveLogPath("TURN_TRACE_LOG_FILE", DEFAULT_TURN_TRACE_FILE),
  backgroundTraceFile: resolveLogPath("BACKGROUND_TRACE_LOG_FILE", DEFAULT_BACKGROUND_TRACE_FILE)
} as const;

export class TurnTrace {
  private readonly startedAt = Date.now();
  private readonly phases: Record<string, number> = {};
  private readonly metadata: JsonRecord = {};

  constructor(private readonly base: JsonRecord) {}

  measure<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    return fn().then((value) => {
      this.phases[phase] = Date.now() - started;
      return value;
    }).catch((error) => {
      this.phases[phase] = Date.now() - started;
      throw error;
    });
  }

  recordPhase(phase: string, durationMs: number): void {
    this.phases[phase] = durationMs;
  }

  set(key: string, value: unknown): void {
    this.metadata[key] = value;
  }

  setMany(values: JsonRecord): void {
    Object.assign(this.metadata, values);
  }

  async flush(extra: JsonRecord = {}): Promise<void> {
    if (!traceConfig.enableTurnTrace) return;
    try {
      await appendJsonLine(traceConfig.turnTraceFile, {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - this.startedAt,
        ...this.base,
        phases: this.phases,
        ...this.metadata,
        ...extra
      });
    } catch (error) {
      console.warn("[trace] Failed to write turn trace:", error instanceof Error ? error.message : error);
    }
  }
}

export const createTurnTrace = (base: JsonRecord): TurnTrace => new TurnTrace(base);

export const writeBackgroundTrace = async (payload: JsonRecord): Promise<void> => {
  if (!traceConfig.enableBackgroundTrace) return;
  try {
    await appendJsonLine(traceConfig.backgroundTraceFile, {
      timestamp: new Date().toISOString(),
      ...payload
    });
  } catch (error) {
    console.warn("[trace] Failed to write background trace:", error instanceof Error ? error.message : error);
  }
};
