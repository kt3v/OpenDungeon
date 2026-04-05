import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
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
      "  --typescript    Add TypeScript entry point (src/index.ts) for custom mechanics"
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
    typescript
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
const createModuleFiles = ({ absTargetDir, packageName, contentSdkDependency, typescript, dryRun }) => {
  // Entry is either the compiled JS path or "declarative" for pure declarative modules
  const entry = typescript ? "dist/index.js" : "declarative";

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
        main: "dist/index.js",
        files: [
          "dist",
          "manifest.json",
          "setting.json",
          "classes.json",
          "dm.md",
          "dm-config.json",
          "initial-state.json",
          "skills",
          "resources",
          "hooks",
          "rules",
          "lore"
        ],
        scripts: {
          build: "tsc -p tsconfig.json",
          typecheck: "tsc -p tsconfig.json --noEmit"
        },
        dependencies: {
          "@opendungeon/content-sdk": contentSdkDependency
        },
        devDependencies: {
          typescript: "^5.8.3"
        }
      }
    : {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        files: [
          "manifest.json",
          "setting.json",
          "classes.json",
          "dm.md",
          "dm-config.json",
          "initial-state.json",
          "skills",
          "resources",
          "hooks",
          "rules",
          "lore"
        ]
      };

  const tsconfig = typescript
    ? {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          noUncheckedIndexedAccess: true,
          noImplicitOverride: true,
          outDir: "dist",
          rootDir: "src"
        },
        include: ["src/**/*.ts"]
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

## Output Format
Return valid JSON with key "message" (player-facing narration).
Optional keys: toolCalls, worldPatch, summaryPatch, suggestedActions.

## Rules
- Keep narration concise and atmospheric.
- Prefer small, targeted worldPatch updates.
- Suggested actions must be concrete and immediately playable.
`;

  const dmConfigJson = {
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
      { id: "look", label: "Look Around", prompt: "look around carefully" },
      { id: "listen", label: "Listen", prompt: "listen for sounds" },
      { id: "advance", label: "Advance", prompt: "move cautiously forward" }
    ]
  };

  const initialStateJson = {};

  const lookSkill = {
    id: "look",
    description: "Observe your immediate surroundings",
    dmPromptExtension: "When the player looks around, the DM describes the current location in vivid detail.",
    resolve: "ai"
  };

  const hpResource = {
    id: "hp",
    label: "HP",
    source: "character",
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

  const startingGearHook = {
    id: "starting-gear",
    hook: "onCharacterCreated",
    characterPatch: {
      location: "start",
      inventory: []
    }
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
import { myMechanic } from "./mechanics/my-mechanic.js";

/**
 * TypeScript extension for ${packageName}.
 *
 * All module data (classes, DM config, setting, skills, resources)
 * is loaded from JSON/Markdown files in the module root.
 *
 * This file only exports additional mechanics that implement complex,
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
 * - Inject context into DM prompts via dmPromptExtension
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
  },

  dmPromptExtension: ({ worldState }) => {
    return "Custom mechanic context for the DM.";
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

# Start OpenDungeon
${typescript ? `cd ${absTargetDir} && pnpm install && pnpm build\n\n# Then:` : ""}pnpm dev:full
\`\`\`

${typescript ? "After editing TypeScript files, run `pnpm build` to recompile." : "No build step needed — edit JSON/Markdown files directly."}

## Project Structure

\`\`\`
├── manifest.json         # Module metadata
├── setting.json          # World config (era, tone, themes, taboos)
├── classes.json          # Character class definitions
├── dm.md                 # DM system prompt (Markdown)
├── dm-config.json        # DM guardrails, tool policy, default actions
├── initial-state.json    # Starting worldState for new campaigns
├── lore/                 # Markdown lore files
│   └── README.md
├── skills/               # Declarative JSON skills
│   └── look.json
├── resources/            # UI resource indicators
│   ├── hp.json
│   └── location.json
├── hooks/                # Declarative mechanic hooks
│   └── starting-gear.json
${typescript ? `├── src/                  # TypeScript mechanics (optional)
│   ├── index.ts          # Entry point — exports mechanics only
│   └── mechanics/
│       └── my-mechanic.ts` : "# TypeScript mechanics optional — add src/ directory with index.ts if needed"}
\`\`\`

## Adding Gameplay

### Skills (skills/*.json)
Drop JSON files — picked up automatically:
\`\`\`json
{
  "id": "rest",
  "description": "Rest to recover",
  "resolve": "deterministic",
  "outcome": { "message": "You rest.", "characterPatch": { "rested": true } }
}
\`\`\`

### Hooks (hooks/*.json)
Set initial state or react to session events:
\`\`\`json
{
  "id": "warrior-start",
  "hook": "onCharacterCreated",
  "classBranches": {
    "Warrior": { "characterPatch": { "gold": 5 } },
    "Mage": { "characterPatch": { "gold": 10 } }
  }
}
\`\`\`

### Rules (rules/*.json)
Apply effects after every action — drain HP, tick timers, check death:
\`\`\`json
{
  "id": "poison-tick",
  "trigger": "onActionResolved",
  "condition": { "key": "characterState.poisoned", "operator": "==", "value": true },
  "effects": [{ "op": "decrement", "target": "characterState.hp", "amount": 3, "min": 0 }]
}
\`\`\`

${typescript ? `### TypeScript Mechanics (src/mechanics/*.ts)
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

Don't forget to import and add to the mechanics array in \`src/index.ts\`!` : "### TypeScript Mechanics (optional)\n\nFor complex logic, create `src/index.ts` and point `entry` in manifest.json to `dist/index.js`."}

See the [game-example](../packages/game-example/) for a reference implementation.
`;

  // Build file list
  const files = [
    { path: resolve(absTargetDir, "package.json"), content: JSON.stringify(packageJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "manifest.json"), content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: resolve(absTargetDir, ".gitignore"), content: `node_modules\n${typescript ? "dist\n" : ""}` },
    { path: resolve(absTargetDir, "README.md"), content: readme },
    { path: resolve(absTargetDir, "setting.json"), content: JSON.stringify(settingJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "classes.json"), content: JSON.stringify(classesJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "dm.md"), content: dmMd },
    { path: resolve(absTargetDir, "dm-config.json"), content: JSON.stringify(dmConfigJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "initial-state.json"), content: JSON.stringify(initialStateJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "skills/look.json"), content: JSON.stringify(lookSkill, null, 2) + "\n" },
    { path: resolve(absTargetDir, "resources/hp.json"), content: JSON.stringify(hpResource, null, 2) + "\n" },
    { path: resolve(absTargetDir, "resources/location.json"), content: JSON.stringify(locationResource, null, 2) + "\n" },
    { path: resolve(absTargetDir, "hooks/starting-gear.json"), content: JSON.stringify(startingGearHook, null, 2) + "\n" },
    { path: resolve(absTargetDir, "lore/README.md"), content: loreReadme }
  ];

  if (typescript) {
    files.push(
      { path: resolve(absTargetDir, "tsconfig.json"), content: JSON.stringify(tsconfig, null, 2) + "\n" },
      { path: resolve(absTargetDir, "src/index.ts"), content: indexTs },
      { path: resolve(absTargetDir, "src/mechanics/my-mechanic.ts"), content: exampleMechanicTs }
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
  mkdirSync(resolve(absTargetDir, "skills"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "resources"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "hooks"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "lore"), { recursive: true });
  if (typescript) {
    mkdirSync(resolve(absTargetDir, "src"), { recursive: true });
    mkdirSync(resolve(absTargetDir, "src/mechanics"), { recursive: true });
  }

  for (const file of files) {
    writeFileSync(file.path, file.content, "utf8");
  }
};

const run = async () => {
  let options = parseArgs(process.argv.slice(2));
  if (!options.targetDir) {
    options = await askInteractiveOptions(options);
  }

  const absTargetDir = resolve(rootDir, options.targetDir);
  const packageName = options.packageName || inferPackageName(absTargetDir);

  ensureWritableTarget(absTargetDir, options.force);

  const contentSdkDependency = options.typescript ? getContentSdkDependency(absTargetDir) : null;

  createModuleFiles({
    absTargetDir,
    packageName,
    contentSdkDependency,
    typescript: options.typescript,
    dryRun: options.dryRun
  });

  process.stdout.write(`Game module scaffold ready: ${absTargetDir}\n`);
  process.stdout.write(`Package name: ${packageName}\n\n`);

  if (options.typescript) {
    process.stdout.write("This module includes TypeScript mechanics.\n");
    process.stdout.write("Next steps:\n");
    process.stdout.write(`  1) cd ${absTargetDir} && pnpm install\n`);
    process.stdout.write(`  2) pnpm build\n`);
    process.stdout.write(`  3) Set GAME_MODULE_PATH=${absTargetDir} in OpenDungeon .env.local\n`);
    process.stdout.write(`  4) Start the engine: pnpm dev:full\n`);
    process.stdout.write("\nAfter editing TypeScript, run `pnpm build` to recompile.\n");
  } else {
    process.stdout.write("This is a declarative module — no build step needed.\n");
    process.stdout.write("Next steps:\n");
    process.stdout.write(`  1) Set GAME_MODULE_PATH=${absTargetDir} in OpenDungeon .env.local\n`);
    process.stdout.write(`  2) Edit setting.json, classes.json, dm.md to describe your world\n`);
    process.stdout.write(`  3) Start the engine: pnpm dev:full\n`);
    process.stdout.write("\nTip: run 'od architect scaffold' to have AI generate your content\n");
    process.stdout.write("     To add TypeScript later, create src/index.ts and update manifest.json#entry\n");
  }
};

run().catch((error) => {
  process.stderr.write(`create-game-module failed: ${String(error)}\n`);
  process.stderr.write("Run with --help for usage.\n");
  process.exit(1);
});
