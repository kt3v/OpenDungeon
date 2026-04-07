import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rootDir = process.cwd();
const localContentSdkPath = resolve(rootDir, "packages/content-sdk");

const usage = () => {
  process.stdout.write(
    [
      "OpenDungeon game module generator",
      "",
      "Creates a game module with declarative JSON/Markdown files.",
      "Optional: add TypeScript mechanics with --typescript flag.",
      "",
      "Usage:",
      "  pnpm od create-module <target-dir> [--name @scope/module-name] [--force] [--dry-run] [--typescript]",
      "  pnpm od create-module",
      "",
      "Examples:",
      "  pnpm od create-module ../my-dungeon-module",
      "  pnpm od create-module ../my-dungeon-module --name @indie/my-dungeon",
      "  pnpm od create-module packages/game-dark --force",
      "  pnpm od create-module ../my-game --typescript  # adds src/index.ts for custom mechanics",
      "  pnpm od create-module    # interactive mode",
      "",
      "Flags:",
      "  --typescript    Add TypeScript entry point (src/index.ts) for custom mechanics",
      "  --no-web        Skip generating the web UI module (web/<slug>/ directory)"
    ].join("\n") + "\n"
  );
};

const parseArgs = (argv) => {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  let targetDir = "";
  let packageName;
  let force = false;
  let dryRun = false;
  let typescript = false;
  let web = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg) {
      continue;
    }

    if (arg === "--name") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --name");
      }
      packageName = value.trim();
      i += 1;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--typescript") {
      typescript = true;
      continue;
    }

    // Legacy alias removed — all modules now use declarative base
    if (arg === "--declarative") {
      typescript = false;
      continue;
    }

    if (arg === "--no-web") {
      web = false;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!targetDir) {
      targetDir = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return {
    targetDir,
    packageName,
    force,
    dryRun,
    typescript,
    web
  };
};

const askInteractiveOptions = async (partialOptions) => {
  const rl = readline.createInterface({ input, output });

  try {
    output.write("OpenDungeon interactive module scaffold\n\n");

    let targetDir = partialOptions.targetDir;
    while (!targetDir) {
      const answer = (await rl.question("Target directory (example ../my-dungeon-module): ")).trim();
      if (answer) {
        targetDir = answer;
      }
    }

    const inferred = inferPackageName(resolve(rootDir, targetDir));
    const packageNamePrompt = partialOptions.packageName
      ? partialOptions.packageName
      : await rl.question(`Package name (default ${inferred}): `);

    const packageName = packageNamePrompt.trim() || inferred;

    const typescriptAnswer = await rl.question("Add TypeScript mechanics? (y/N): ");
    const typescript = typescriptAnswer.trim().toLowerCase() === "y";

    return {
      ...partialOptions,
      targetDir,
      packageName,
      typescript
    };
  } finally {
    rl.close();
  }
};

const toKebab = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

const inferPackageName = (absTargetDir) => {
  const folderName = absTargetDir.split("/").filter(Boolean).at(-1) ?? "game-module";
  const slug = toKebab(folderName) || "game-module";
  return `@opendungeon/${slug}`;
};

const ensureWritableTarget = (absTargetDir, force) => {
  if (!existsSync(absTargetDir)) {
    return;
  }

  const entries = readdirSync(absTargetDir);
  if (entries.length === 0) {
    return;
  }

  if (!force) {
    throw new Error(`Target directory is not empty: ${absTargetDir}. Use --force to overwrite scaffold files.`);
  }
};

const getContentSdkDependency = (absTargetDir) => {
  if (!existsSync(localContentSdkPath)) {
    return "^1.0.0";
  }

  const relPath = relative(absTargetDir, localContentSdkPath).replace(/\\/g, "/");
  const normalized = relPath.startsWith(".") ? relPath : `./${relPath}`;
  return `file:${normalized}`;
};

/**
 * Generate a game module.
 * All modules include declarative JSON/Markdown files.
 * TypeScript mechanics are optional (--typescript flag).
 */
const createModuleFiles = ({ absTargetDir, packageName, typescript, dryRun }) => {
  // Entry is either the TypeScript source path or "declarative" for pure declarative modules
  const entry = typescript ? "content/mechanics/index.ts" : "declarative";

  const manifest = {
    name: packageName,
    version: "0.1.0",
    engine: "^1.0.0",
    contentApi: "^1.0.0",
    capabilities: [],
    entry,
    stateVersion: 1
  };

  const packageJson = typescript
    ? {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "content/mechanics/index.ts",
        files: ["content", "manifest.json"],
        scripts: {
          typecheck: "tsc -p tsconfig.json --noEmit"
        }
      }
    : {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        files: ["content", "manifest.json"]
      };

  // Compute relative paths from game dir to monorepo root files
  const rootTsconfigPath = resolve(rootDir, "tsconfig.base.json");
  const relToBase = relative(absTargetDir, rootTsconfigPath).replace(/\\/g, "/");
  const tsconfigExtends = relToBase.startsWith(".") ? relToBase : `./${relToBase}`;

  const contentSdkSrcPath = resolve(rootDir, "packages/content-sdk/src");
  const relToContentSdk = relative(absTargetDir, contentSdkSrcPath).replace(/\\/g, "/");
  const contentSdkSrcRel = relToContentSdk.startsWith(".") ? relToContentSdk : `./${relToContentSdk}`;

  const tsconfig = typescript
    ? {
        extends: tsconfigExtends,
        compilerOptions: {
          noEmit: true,
          baseUrl: ".",
          paths: {
            "@opendungeon/content-sdk": [`${contentSdkSrcRel}/index.ts`],
            "@opendungeon/content-sdk/*": [`${contentSdkSrcRel}/*`]
          }
        },
        include: ["content/mechanics/**/*.ts"]
      }
    : null;

  // All modules get these declarative files
  const settingJson = {
    name: "",
    description: "",
    era: "",
    realismLevel: "soft",
    tone: "",
    themes: [],
    magicSystem: "",
    taboos: [],
    custom: {}
  };

  const classesJson = {
    fallback: {
      level: 1,
      hp: 100,
      attributes: { strength: 10, agility: 10, intellect: 10 }
    },
    classes: [
      {
        name: "Adventurer",
        level: 1,
        hp: 100,
        attributes: { strength: 10, agility: 10, intellect: 10 }
      }
    ]
  };

  const dmMd = `You are a Dungeon Master for ${packageName}.

## Rules
- Keep narration concise and atmospheric.
- Prefer small, targeted worldPatch updates.
- Suggested actions must be concrete and immediately playable.
`;

  const dmConfigJson = {
    contextRouter: {
      enabled: true,
      contextTokenBudget: 1200,
      maxCandidates: 8,
      maxSelectedModules: 4
    },
    toolPolicy: {
      allowedTools: ["update_world_state", "set_summary", "set_suggested_actions"],
      requireSummary: true,
      requireSuggestedActions: true
    },
    guardrails: {
      maxSuggestedActions: 4,
      maxSummaryChars: 220
    },
    defaultSuggestedActions: [
      { id: "look", label: "I open my eyes", prompt: "I open my eyes" }
    ]
  };

  const initialStateJson = {
    lastObservation: "none",
    lastSound: "none"
  };

  const explorationModule = `---
id: exploration
priority: 90
alwaysInclude: true
triggers:
  - look
  - inspect
  - explore
dependsOn:
  - module:sound-awareness
references:
  - character:location
  - world:lastObservation
  - world:lastSound
provides:
  - world:lastObservation
when:
  - exploration
---

## Exploration Guidance
- Keep descriptions grounded in current location and recent state changes.
- Surface actionable details, not only atmosphere.
- Update world state only with concrete, discoverable facts.
`;

  const soundAwarenessModule = `---
id: sound-awareness
priority: 70
triggers:
  - listen
  - hear
  - sound
references:
  - character:location
  - world:lastSound
provides:
  - world:lastSound
when:
  - exploration
  - infiltration
---

## Sound Awareness Guidance
- Describe ambient and directional sounds tied to current location.
- Persist relevant clues via worldPatch.lastSound using compact snake_case values.
- Favor actionable audio information over purely decorative flavor.
`;

  const hpResource = {
    id: "hp",
    label: "HP",
    source: "characterState",
    stateKey: "hp",
    type: "number"
  };

  const locationResource = {
    id: "location",
    label: "Location",
    source: "characterState",
    stateKey: "location",
    type: "text",
    defaultValue: "Unknown"
  };

  const loreReadme = `# Lore Files

Add markdown files to this directory for detailed world building.
Each .md file will be loaded and injected into the DM's system prompt.

## Suggested files

- factions.md — Organizations, guilds, political powers
- locations.md — Notable places, geography
- history.md — Timeline of major events
`;

  // TypeScript entry point (only for --typescript)
  const indexTs = typescript
    ? `import { defineMechanics } from "@opendungeon/content-sdk";
import { myMechanic } from "./logic/my-mechanic.js";

/**
 * TypeScript mechanics entry point for ${packageName}.
 *
 * All game content (classes, DM config, setting, context modules, indicators)
 * is loaded from JSON/Markdown files in the content/ directory.
 *
 * This file only exports mechanics that implement complex,
 * stateful gameplay logic beyond what declarative files can express.
 */
export default defineMechanics({
  mechanics: [myMechanic]
});
`
    : null;

  const exampleMechanicTs = typescript
    ? `import { defineMechanic } from "@opendungeon/content-sdk";

/**
 * Example mechanic — replace with your own.
 *
 * Mechanics can:
 * - React to lifecycle hooks (onCharacterCreated, onSessionStart, onActionResolved, onSessionEnd)
 * - Define deterministic actions (validate + resolve)
 */
export const myMechanic = defineMechanic({
  id: "my-mechanic",

  hooks: {
    onSessionStart: async (ctx) => {
      // Initialize session-specific state
      return {
        worldPatch: {
          sessionStarted: true
        }
      };
    }
  }
});
`
    : null;

  const readme = `# ${packageName}

An OpenDungeon game module.

## Quick Start

\`\`\`bash
# Set the game module path in OpenDungeon .env.local:
GAME_MODULE_PATH=${absTargetDir}

# Start OpenDungeon (from the engine root)
pnpm dev:full
\`\`\`

${typescript ? "TypeScript files are loaded directly — no build step needed. Run `pnpm typecheck` to check types." : "No build step needed — edit JSON/Markdown files directly."}

## Project Structure

\`\`\`
├── manifest.json              # Module identity and entry point
├── package.json               # Package metadata
${typescript ? `├── tsconfig.json              # TypeScript config (typecheck only)
` : ""}└── content/
    ├── setting.json           # World config (era, tone, themes, taboos)
    ├── classes.json           # Character class definitions
    ├── dm.md                  # DM system prompt (Markdown)
    ├── dm-config.json         # DM guardrails, tool policy, default actions
    ├── initial-state.json     # Starting worldState for new campaigns
    ├── modules/               # Routed Markdown context modules
    │   └── exploration.md
    │   └── sound-awareness.md
    ├── lore/                  # Markdown world-building files
    │   └── README.md
    ├── indicators/            # UI resource indicators
    │   ├── hp.json
    │   └── location.json
${typescript ? `    └── mechanics/             # TypeScript mechanics
        ├── index.ts           # Entry point — exports mechanics array
        └── logic/
            └── my-mechanic.ts` : "    └── mechanics/             # (optional) TypeScript mechanics\n        # create index.ts and set manifest.json#entry: \"content/mechanics/index.ts\""}
\`\`\`

## Adding Gameplay

### Context Modules (content/modules/*.md)
Store gameplay and narrative guidance in routed Markdown modules:
\`\`\`markdown
---
id: stamina
priority: 80
triggers:
  - run
  - sprint
references:
  - character:stamina
provides:
  - world:lastFatigueState
---

## Stamina Guidance
- Running drains stamina over time.
- If stamina is low, reflect fatigue in narrative and suggested actions.
\`\`\`

${typescript ? `### TypeScript Mechanics (content/mechanics/logic/*.ts)
For complex logic that declarative files can't express:

\`\`\`typescript
import { defineMechanic } from "@opendungeon/content-sdk";

export const myMechanic = defineMechanic({
  id: "complex-logic",
  hooks: {
    onActionResolved: async (result, ctx) => {
      // Custom logic here
      return result;
    }
  }
});
\`\`\`

Import and add to the mechanics array in \`content/mechanics/index.ts\`.` : "### TypeScript Mechanics (optional)\n\nCreate `content/mechanics/index.ts`, set `entry` in manifest.json to `\"content/mechanics/index.ts\"`. No build step needed."}

See the [game-example](../packages/game-example/) for a reference implementation.
`;

  // content/ prefix shorthand
  const c = (p) => resolve(absTargetDir, "content", p);

  // Build file list
  const files = [
    { path: resolve(absTargetDir, "package.json"), content: JSON.stringify(packageJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "manifest.json"), content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: resolve(absTargetDir, ".gitignore"), content: "node_modules\n" },
    { path: resolve(absTargetDir, "README.md"), content: readme },
    { path: c("setting.json"), content: JSON.stringify(settingJson, null, 2) + "\n" },
    { path: c("classes.json"), content: JSON.stringify(classesJson, null, 2) + "\n" },
    { path: c("dm.md"), content: dmMd },
    { path: c("dm-config.json"), content: JSON.stringify(dmConfigJson, null, 2) + "\n" },
    { path: c("initial-state.json"), content: JSON.stringify(initialStateJson, null, 2) + "\n" },
    { path: c("modules/exploration.md"), content: explorationModule },
    { path: c("modules/sound-awareness.md"), content: soundAwarenessModule },
    { path: c("indicators/hp.json"), content: JSON.stringify(hpResource, null, 2) + "\n" },
    { path: c("indicators/location.json"), content: JSON.stringify(locationResource, null, 2) + "\n" },
    { path: c("lore/README.md"), content: loreReadme }
  ];

  if (typescript) {
    files.push(
      { path: resolve(absTargetDir, "tsconfig.json"), content: JSON.stringify(tsconfig, null, 2) + "\n" },
      { path: c("mechanics/index.ts"), content: indexTs },
      { path: c("mechanics/logic/my-mechanic.ts"), content: exampleMechanicTs }
    );
  }

  if (dryRun) {
    process.stdout.write(`Dry run: would write ${files.length} files to ${absTargetDir}\n`);
    for (const file of files) {
      process.stdout.write(`  - ${file.path}\n`);
    }
    return;
  }

  // Create directories
  mkdirSync(c("modules"), { recursive: true });
  mkdirSync(c("indicators"), { recursive: true });
  mkdirSync(c("lore"), { recursive: true });
  if (typescript) {
    mkdirSync(c("mechanics/logic"), { recursive: true });
  }

  for (const file of files) {
    writeFileSync(file.path, file.content, "utf8");
  }
};

// ── .env.local helpers ────────────────────────────────────────────────────────

const readEnvLocal = () => {
  const envPath = resolve(rootDir, ".env.local");
  if (!existsSync(envPath)) return { lines: [], map: new Map() };
  const lines = readFileSync(envPath, "utf8").split("\n");
  const map = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    map.set(line.slice(0, eqIdx).trim(), line.slice(eqIdx + 1));
  }
  return { lines, map };
};

const writeEnvLocal = (lines, map) => {
  const result = [];
  const written = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { result.push(line); continue; }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) { result.push(line); continue; }
    const key = line.slice(0, eqIdx).trim();
    written.add(key);
    result.push(`${key}=${map.get(key) ?? ""}`);
  }
  for (const [key, val] of map) {
    if (!written.has(key)) result.push(`${key}=${val}`);
  }
  let out = result.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!out.endsWith("\n")) out += "\n";
  writeFileSync(resolve(rootDir, ".env.local"), out, "utf8");
};

// ── Web module scaffold ────────────────────────────────────────────────────────

const SKIP_ON_COPY = new Set(["node_modules", ".next", ".turbo", "tsconfig.tsbuildinfo"]);

const copyFilter = (src) => {
  const name = basename(src);
  return !SKIP_ON_COPY.has(name) && !name.endsWith(".tsbuildinfo");
};

const createWebModule = ({ absWebDir, dryRun }) => {
  const defaultUiPath = resolve(rootDir, "apps/web/src/default");

  if (!existsSync(defaultUiPath)) {
    process.stdout.write(`  Warning: apps/web/src/default not found, skipping web module.\n`);
    return;
  }

  if (dryRun) {
    process.stdout.write(`Dry run: would copy apps/web/src/default → ${absWebDir}\n`);
    return;
  }

  mkdirSync(absWebDir, { recursive: true });
  cpSync(defaultUiPath, absWebDir, { recursive: true });
};

const run = async () => {
  let options = parseArgs(process.argv.slice(2));
  if (!options.targetDir) {
    options = await askInteractiveOptions(options);
  }

  const absTargetDir = resolve(rootDir, options.targetDir);
  const packageName = options.packageName || inferPackageName(absTargetDir);

  // Derive web module path: <rootDir>/web/<slug>
  const slug = toKebab(absTargetDir.split("/").filter(Boolean).at(-1) ?? "game-module") || "game-module";
  const absWebDir = resolve(rootDir, "web", slug);
  const relWebPath = `./web/${slug}`;

  // Always update .env.local first (before scaffold, so paths are set even if scaffold is skipped)
  if (!options.dryRun) {
    const relGamePath = relative(rootDir, absTargetDir).replace(/\\/g, "/");
    const gamePath = relGamePath.startsWith(".") ? relGamePath : `./${relGamePath}`;
    const { lines, map } = readEnvLocal();
    map.set("GAME_MODULE_PATH", gamePath);
    if (options.web) {
      map.set("WEB_MODULE_PATH", relWebPath);
    }
    writeEnvLocal(lines, map);
    process.stdout.write(`Updated .env.local: GAME_MODULE_PATH=${gamePath}\n`);
    if (options.web) {
      process.stdout.write(`Updated .env.local: WEB_MODULE_PATH=${relWebPath}\n`);
    }
  }

  ensureWritableTarget(absTargetDir, options.force);

  createModuleFiles({
    absTargetDir,
    packageName,
    typescript: options.typescript,
    dryRun: options.dryRun
  });

  if (options.web) {
    createWebModule({ absWebDir, dryRun: options.dryRun });
  }

  process.stdout.write(`\nGame module scaffold ready: ${absTargetDir}\n`);
  process.stdout.write(`Package name: ${packageName}\n`);

  if (options.web) {
    process.stdout.write(`\nWeb UI module scaffold ready: ${absWebDir}\n`);
    process.stdout.write(`Package name: ${packageName}-web\n`);
  }

  process.stdout.write("\n");

  if (options.typescript) {
    process.stdout.write("This module includes TypeScript mechanics.\n");
    process.stdout.write("No build step needed — TypeScript is loaded directly by the engine.\n");
  } else {
    process.stdout.write("This is a declarative module — no build step needed.\n");
  }

  process.stdout.write("\nNext steps:\n");
  let step = 1;
  process.stdout.write(`  ${step++}) Edit content files (setting.json, classes.json, dm.md)\n`);
  if (options.web) {
    process.stdout.write(`  ${step++}) Install web UI deps: cd ${absWebDir} && pnpm install\n`);
  }
  process.stdout.write(`  ${step++}) Start the engine: od start\n`);

  if (!options.typescript) {
    process.stdout.write("\nTip: run 'od architect scaffold' to have AI generate your content\n");
  } else {
    process.stdout.write("\nTip: run `pnpm typecheck` in the module directory to check types.\n");
  }
};

run().catch((error) => {
  process.stderr.write(`create-game-module failed: ${String(error)}\n`);
  process.stderr.write("Run with --help for usage.\n");
  process.exit(1);
});
