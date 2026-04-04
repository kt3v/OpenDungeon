import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GameModule } from "@opendungeon/content-sdk";
import { moduleManifestSchema } from "@opendungeon/shared";

export interface LoadedGameModule {
  modulePath: string;
  entryPath: string;
  gameModule: GameModule;
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJsonFile = async (filePath: string): Promise<Record<string, unknown> | null> => {
  if (!(await fileExists(filePath))) {
    return null;
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON object at: ${filePath}`);
  }

  return parsed as Record<string, unknown>;
};

const resolveEntryPath = async (modulePath: string): Promise<string> => {
  const packageJson = await readJsonFile(resolve(modulePath, "package.json"));
  const manifestJson = await readJsonFile(resolve(modulePath, "manifest.json"));

  const packageMain = typeof packageJson?.main === "string" ? packageJson.main : undefined;
  const manifestEntry = typeof manifestJson?.entry === "string" ? manifestJson.entry : undefined;

  const candidates = [packageMain, manifestEntry, "src/index.ts", "src/index.js", "index.ts", "index.js"].filter(
    (value): value is string => Boolean(value)
  );

  for (const candidate of candidates) {
    const candidatePath = resolve(modulePath, candidate);
    if (await fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(
    [
      `Cannot resolve module entry for GAME_MODULE_PATH=${modulePath}`,
      `Checked: ${candidates.join(", ") || "<none>"}`,
      "Provide package.json#main, manifest.json#entry, or one of src/index.ts|src/index.js|index.ts|index.js"
    ].join("\n")
  );
};

const assertGameModule = (value: unknown, sourcePath: string): GameModule => {
  if (!value || typeof value !== "object") {
    throw new Error(`Loaded module from ${sourcePath} is not an object export`);
  }

  const maybeModule = value as Partial<GameModule> & { manifest?: unknown };

  if (!Array.isArray(maybeModule.mechanics)) {
    throw new Error(
      `Loaded module from ${sourcePath} does not export a valid GameModule (missing mechanics array)`
    );
  }

  moduleManifestSchema.parse(maybeModule.manifest);
  return maybeModule as GameModule;
};

export const loadGameModuleFromPath = async (modulePathEnv: string | undefined): Promise<LoadedGameModule> => {
  if (!modulePathEnv || !modulePathEnv.trim()) {
    throw new Error("Missing required env: GAME_MODULE_PATH");
  }

  const resolutionBase = process.env.INIT_CWD && process.env.INIT_CWD.trim() ? process.env.INIT_CWD : process.cwd();
  const modulePath = resolve(resolutionBase, modulePathEnv.trim());
  const entryPath = await resolveEntryPath(modulePath);
  const loaded = await import(pathToFileURL(entryPath).href);
  const exportedValue = "default" in loaded ? loaded.default : loaded;
  const gameModule = assertGameModule(exportedValue, entryPath);

  return {
    modulePath,
    entryPath,
    gameModule
  };
};
