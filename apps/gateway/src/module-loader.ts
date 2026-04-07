import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { GameModule, TypeScriptModuleExtension } from "@opendungeon/content-sdk";
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

const DECLARATIVE_SENTINEL = "declarative";

const resolveEntryPath = async (modulePath: string): Promise<string> => {
  const packageJson = await readJsonFile(resolve(modulePath, "package.json"));
  const manifestJson = await readJsonFile(resolve(modulePath, "manifest.json"));

  const packageMain = typeof packageJson?.main === "string" ? packageJson.main : undefined;
  const manifestEntry = typeof manifestJson?.entry === "string" ? manifestJson.entry : undefined;

  // If entry is explicitly "declarative", no TypeScript extension needed
  if (manifestEntry === DECLARATIVE_SENTINEL) {
    return DECLARATIVE_SENTINEL;
  }

  const candidates = [packageMain, manifestEntry, "src/index.ts", "src/index.js", "index.ts", "index.js"].filter(
    (value): value is string => Boolean(value)
  );

  for (const candidate of candidates) {
    const candidatePath = resolve(modulePath, candidate);
    if (await fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // No TypeScript entry found — will use declarative-only mode
  return DECLARATIVE_SENTINEL;
};

const assertTypeScriptExtension = (value: unknown, sourcePath: string): TypeScriptModuleExtension => {
  if (!value || typeof value !== "object") {
    throw new Error(`Loaded module from ${sourcePath} is not an object export`);
  }

  const maybeExt = value as Partial<TypeScriptModuleExtension>;

  if (!Array.isArray(maybeExt.mechanics)) {
    throw new Error(
      `Loaded module from ${sourcePath} does not export a valid TypeScriptModuleExtension (missing mechanics array)`
    );
  }

  return maybeExt as TypeScriptModuleExtension;
};

export const loadGameModuleFromPath = async (modulePathEnv: string | undefined): Promise<LoadedGameModule> => {
  if (!modulePathEnv || !modulePathEnv.trim()) {
    throw new Error("Missing required env: GAME_MODULE_PATH");
  }

  const resolutionBase = process.env.INIT_CWD && process.env.INIT_CWD.trim() ? process.env.INIT_CWD : process.cwd();
  const modulePath = resolve(resolutionBase, modulePathEnv.trim());
  const entryPath = await resolveEntryPath(modulePath);

  // Load declarative base (always — this is the foundation)
  const { loadDeclarativeModuleBase } = await import("@opendungeon/content-sdk");
  const { base, mechanics: declarativeMechanics, warnings } = loadDeclarativeModuleBase(modulePath);

  for (const warning of warnings) {
    console.warn(`[module-loader] ${warning}`);
  }

  let finalMechanics = declarativeMechanics;

  // If there's a TypeScript entry point, load and merge additional mechanics
  if (entryPath !== DECLARATIVE_SENTINEL) {
    try {
      const entryUrl = pathToFileURL(entryPath).href;
      const loaded = await tsImport(`${entryUrl}?t=${Date.now()}`, { parentURL: import.meta.url });
      const exportedValue = "default" in loaded ? loaded.default : loaded;
      const tsExtension = assertTypeScriptExtension(exportedValue, entryPath);

      // Merge: declarative mechanics first, then TypeScript
      finalMechanics = [...declarativeMechanics, ...tsExtension.mechanics];

      console.log(`[module-loader] Loaded TypeScript extension with ${tsExtension.mechanics.length} mechanics`);
    } catch (err) {
      console.warn(`[module-loader] Failed to load TypeScript extension from ${entryPath}: ${err}`);
      // Continue with declarative-only
    }
  }

  const gameModule: GameModule = {
    ...base,
    mechanics: finalMechanics
  };

  // Validate the manifest
  moduleManifestSchema.parse(gameModule.manifest);

  return {
    modulePath,
    entryPath: entryPath === DECLARATIVE_SENTINEL ? "declarative" : entryPath,
    gameModule
  };
};
