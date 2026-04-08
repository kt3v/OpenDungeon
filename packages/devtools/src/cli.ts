#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { moduleManifestSchema, classesFileSchema, dmConfigFileSchema, initialStateFileSchema } from "@opendungeon/shared";
import { runArchitectCli } from "./architect-cli.js";
import { runArchitectAnalyze } from "./architect-analyze.js";
import { runArchitectScaffold } from "./architect-scaffold.js";
import { printHelp, printError } from "./lib/output.js";
import { runSetup } from "./commands/setup.js";
import { runStart } from "./commands/start.js";
import { runStop } from "./commands/stop.js";
import { runStatus } from "./commands/status.js";
import { runLogs } from "./commands/logs.js";
import { runRealtime } from "./commands/realtime.js";
import { runConfigure } from "./commands/configure.js";
import { runReset } from "./commands/reset.js";
import { runCreateModule } from "./commands/create-module.js";
import { runDoctor } from "./commands/doctor.js";
import { runDrain } from "./commands/drain.js";
import { runWeb } from "./commands/web.js";

const MODULE_DEPENDENCY_PATTERN = /^(?:module:)?[A-Za-z0-9_.-]+$/;
const MACHINE_REFERENCE_PATTERN = /^(world|character|resource|module):[A-Za-z0-9_.-]+$/;

const splitFrontmatter = (raw: string): { frontmatter: string; body: string } => {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: "", body: normalized };
  }

  return {
    frontmatter: match[1] ?? "",
    body: match[2] ?? ""
  };
};

const parsePrimitiveFrontmatterValue = (value: string): unknown => {
  const raw = value.trim();
  if (!raw) return "";

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  if (raw === "true") return true;
  if (raw === "false") return false;

  if (/^-?\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => parsePrimitiveFrontmatterValue(item.trim()))
      .filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  return raw;
};

const parseFrontmatterObject = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) return {};

  const output: Record<string, unknown> = {};
  let activeArrayKey: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (activeArrayKey && trimmed.startsWith("- ")) {
      const next = parsePrimitiveFrontmatterValue(trimmed.slice(2).trim());
      if (typeof next === "string" && next.length > 0) {
        (output[activeArrayKey] as string[]).push(next);
      }
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) {
      activeArrayKey = null;
      continue;
    }

    const key = kv[1]!;
    const valueRaw = kv[2] ?? "";
    if (!valueRaw.trim()) {
      output[key] = [];
      activeArrayKey = key;
      continue;
    }

    output[key] = parsePrimitiveFrontmatterValue(valueRaw);
    activeArrayKey = null;
  }

  return output;
};

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const normalizeDependencyId = (value: string): string => {
  const raw = value.trim();
  if (raw.startsWith("module:")) {
    return raw.slice("module:".length).trim();
  }
  return raw;
};

const collectDottedKeys = (value: unknown, prefix = ""): string[] => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return prefix ? [prefix] : [];
  if (typeof value !== "object") return prefix ? [prefix] : [];

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];

  const keys: string[] = [];
  for (const [k, v] of entries) {
    const next = prefix ? `${prefix}.${k}` : k;
    keys.push(...collectDottedKeys(v, next));
  }
  return keys;
};

const extractWorldReferenceKey = (ref: string): string | null => {
  if (!ref.startsWith("world:")) return null;
  const key = ref.slice("world:".length).trim();
  return key || null;
};

const validateContextFrontmatter = async (
  contentBase: string,
  initialState: Record<string, unknown> | null
): Promise<{ warnings: string[]; hasAny: boolean }> => {
  const warnings: string[] = [];
  const moduleDirs = ["modules", "contexts"];
  const knownModuleIds = new Set<string>();
  const dependenciesByModule = new Map<string, string[]>();
  const referencedWorldKeys = new Set<string>();
  const providedWorldKeys = new Set<string>();
  let hasAny = false;

  for (const dirName of moduleDirs) {
    const dirPath = join(contentBase, dirName);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      hasAny = true;
      const filePath = join(dirPath, file);

      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        warnings.push(`Failed to read ${dirName}/${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const { frontmatter, body } = splitFrontmatter(raw);
      const parsed = parseFrontmatterObject(frontmatter);
      const moduleId =
        (typeof parsed.id === "string" && parsed.id.trim()) ||
        file.replace(/\.md$/, "");

      if (!body.trim()) {
        warnings.push(`${dirName}/${file}: empty body`);
      }

      knownModuleIds.add(moduleId);

      const dependencyValues = toStringArray(parsed.dependsOn ?? parsed.depends ?? parsed.deps);
      const normalizedDeps: string[] = [];
      for (const dep of dependencyValues) {
        if (!MODULE_DEPENDENCY_PATTERN.test(dep)) {
          warnings.push(`${dirName}/${file}: invalid dependsOn entry "${dep}"`);
          continue;
        }
        const depId = normalizeDependencyId(dep);
        if (depId) normalizedDeps.push(depId);
      }
      dependenciesByModule.set(moduleId, normalizedDeps);

      const refValues = toStringArray(parsed.references ?? parsed.refs);
      for (const ref of refValues) {
        if (!MACHINE_REFERENCE_PATTERN.test(ref)) {
          warnings.push(`${dirName}/${file}: invalid references entry "${ref}"`);
          continue;
        }
        const worldKey = extractWorldReferenceKey(ref);
        if (worldKey) referencedWorldKeys.add(worldKey);
      }

      const provideValues = toStringArray(parsed.provides);
      for (const ref of provideValues) {
        if (!MACHINE_REFERENCE_PATTERN.test(ref)) {
          warnings.push(`${dirName}/${file}: invalid provides entry "${ref}"`);
          continue;
        }
        const worldKey = extractWorldReferenceKey(ref);
        if (worldKey) providedWorldKeys.add(worldKey);
      }
    }
  }

  for (const [moduleId, dependencies] of dependenciesByModule.entries()) {
    for (const depId of dependencies) {
      if (!knownModuleIds.has(depId)) {
        warnings.push(`module "${moduleId}": dependsOn references missing module "${depId}"`);
      }
    }
  }

  if (initialState) {
    const initialStateKeys = new Set(collectDottedKeys(initialState));
    for (const key of referencedWorldKeys) {
      if (!initialStateKeys.has(key)) {
        warnings.push(`reference integrity: world reference "${key}" has no default in initial-state.json`);
      }
    }
    for (const key of providedWorldKeys) {
      if (!initialStateKeys.has(key)) {
        warnings.push(`reference integrity: world provide "${key}" has no default in initial-state.json`);
      }
    }
    for (const key of initialStateKeys) {
      if (!referencedWorldKeys.has(key) && !providedWorldKeys.has(key)) {
        warnings.push(`reference integrity: initial-state key "${key}" is not referenced/provided by any context module`);
      }
    }
  }

  return { warnings, hasAny };
};

const command = process.argv[2];
const restArgs = process.argv.slice(3);

try {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    case "setup":
      await runSetup(restArgs);
      break;

    case "start":
      await runStart(restArgs);
      break;

    case "stop":
      await runStop(restArgs);
      break;

    case "status":
      await runStatus(restArgs);
      break;

    case "logs":
      await runLogs(restArgs);
      break;

    case "realtime":
      await runRealtime(restArgs);
      break;

    case "configure":
      await runConfigure(restArgs);
      break;

    case "reset":
      await runReset(restArgs);
      break;

    case "create-module":
    case "create-game-module":
      await runCreateModule(restArgs);
      break;

    case "architect": {
      const subcommand = restArgs[0];
      if (subcommand === "analyze") {
        await runArchitectAnalyze(restArgs.slice(1));
      } else if (subcommand === "scaffold") {
        await runArchitectScaffold(restArgs.slice(1));
      } else {
        await runArchitectCli(restArgs);
      }
      break;
    }

    case "validate-module": {
      const strictFrontmatter = restArgs.includes("--strict") || restArgs.includes("--strict-frontmatter");
      const args = restArgs.filter((arg) => arg !== "--strict" && arg !== "--strict-frontmatter");
      const target = args[0];
      if (!target) {
        process.stdout.write(
          "Usage: od validate-module <path-to-manifest.json | module-dir> [--strict-frontmatter]\n"
        );
        process.exit(1);
      }

      const targetPath = resolve(process.cwd(), target);
      // Accept either a path to manifest.json or to the module directory
      const manifestPath = targetPath.endsWith("manifest.json")
        ? targetPath
        : join(targetPath, "manifest.json");
      const moduleDir = dirname(manifestPath);
      const contentBase = await (async () => {
        const contentPath = join(moduleDir, "content");
        try {
          await access(contentPath);
          return contentPath;
        } catch {
          return moduleDir;
        }
      })();

      const errors: string[] = [];
      const warnings: string[] = [];
      let hasAny = false;
      let parsedInitialState: Record<string, unknown> | null = null;

      // manifest.json (required)
      try {
        const content = await readFile(manifestPath, "utf8");
        const manifest = JSON.parse(content) as unknown;
        moduleManifestSchema.parse(manifest);
        process.stdout.write(`✓ manifest.json\n`);
        hasAny = true;
      } catch (err) {
        errors.push(`manifest.json: ${err instanceof Error ? err.message : String(err)}`);
      }

      // classes.json (optional)
      const classesPath = join(contentBase, "classes.json");
      try {
        await access(classesPath);
        const content = await readFile(classesPath, "utf8");
        classesFileSchema.parse(JSON.parse(content));
        process.stdout.write(`✓ classes.json\n`);
        hasAny = true;
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
          errors.push(`classes.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // dm-config.json (optional)
      const dmConfigPath = join(contentBase, "dm-config.json");
      try {
        await access(dmConfigPath);
        const content = await readFile(dmConfigPath, "utf8");
        dmConfigFileSchema.parse(JSON.parse(content));
        process.stdout.write(`✓ dm-config.json\n`);
        hasAny = true;
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
          errors.push(`dm-config.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // initial-state.json (optional)
      const initialStatePath = join(contentBase, "initial-state.json");
      try {
        await access(initialStatePath);
        const content = await readFile(initialStatePath, "utf8");
        parsedInitialState = initialStateFileSchema.parse(JSON.parse(content));
        process.stdout.write(`✓ initial-state.json\n`);
        hasAny = true;
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
          errors.push(`initial-state.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const frontmatterValidation = await validateContextFrontmatter(contentBase, parsedInitialState);
      if (frontmatterValidation.hasAny) {
        process.stdout.write("✓ context modules frontmatter\n");
        hasAny = true;
      }

      if (frontmatterValidation.warnings.length > 0) {
        if (strictFrontmatter) {
          errors.push(...frontmatterValidation.warnings.map((warning) => `frontmatter: ${warning}`));
        } else {
          warnings.push(...frontmatterValidation.warnings);
        }
      }

      if (!hasAny && errors.length === 0) {
        process.stdout.write("No module files found. Provide a path to a module directory or manifest.json.\n");
        process.exit(1);
      }

      if (errors.length > 0) {
        process.stderr.write(`\nValidation errors:\n`);
        for (const err of errors) {
          process.stderr.write(`  ✗ ${err}\n`);
        }
        process.exit(1);
      }

      if (warnings.length > 0) {
        process.stdout.write("\nValidation warnings:\n");
        for (const warning of warnings) {
          process.stdout.write(`  ! ${warning}\n`);
        }
      }

      process.stdout.write(`\nAll files valid.\n`);
      break;
    }

    case "drain":
      await runDrain(restArgs);
      break;

    case "doctor":
      await runDoctor(restArgs);
      break;

    case "web":
      await runWeb(restArgs);
      break;

    default:
      printError(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31mError:\x1b[0m ${msg}\n`);
  process.exit(1);
}
