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
      "Usage:",
      "  npm run create:game-module -- <target-dir> [--name @scope/module-name] [--force] [--dry-run]",
      "  npm run create:game-module",
      "",
      "Examples:",
      "  npm run create:game-module -- ../my-dungeon-module",
      "  npm run create:game-module -- ../my-dungeon-module --name @indie/my-dungeon",
      "  npm run create:game-module -- packages/game-dark --force",
      "  npm run create:game-module    # interactive mode"
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
    dryRun
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

    return {
      ...partialOptions,
      targetDir,
      packageName
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

const createFiles = ({ absTargetDir, packageName, contentSdkDependency, dryRun }) => {
  const manifest = {
    name: packageName,
    version: "0.1.0",
    engine: "^1.0.0",
    contentApi: "^1.0.0",
    capabilities: [],
    entry: "src/index.ts",
    stateVersion: 1
  };

  const packageJson = {
    name: packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "src/index.ts",
    files: [
      "dist",
      "manifest.json",
      "skills",
      "lore",
      "setting.json"
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
  };

  const tsconfig = {
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
  };

  const indexTs = `import { defineGameModule, loadSkillsDirSync, loadLoreFilesSync } from "@opendungeon/content-sdk";
import { dmConfig } from "./content/dm-config.js";
import { availableClasses, getCharacterTemplate } from "./content/classes.js";
import settingConfig from "../setting.json" with { type: "json" };

const manifest = ${JSON.stringify(manifest, null, 2)};

export default defineGameModule({
  manifest,

  initial: {
    /** Returns the world state for a brand-new campaign. */
    worldState: () => ({
      location: "start"
    })
  },

  characters: {
    availableClasses,
    getTemplate: getCharacterTemplate
  },

  /**
   * Setting / World Bible — base lore, tone, and constraints for all campaigns.
   * This establishes the world before any runtime lore is added.
   * 
   * Edit setting.json to customize your world, or leave blank for generic fantasy.
   */
  setting: {
    /** Structured setting configuration from setting.json */
    config: settingConfig as import("@opendungeon/content-sdk").SettingConfig,
    /** Markdown lore files loaded from the lore/ directory */
    loreFiles: loadLoreFilesSync(new URL("../lore", import.meta.url).pathname)
  },

  dm: dmConfig,

  /** TypeScript mechanics — use for complex state logic and hooks. */
  mechanics: [],

  /** 
   * Declarative skills — drop a .json file into skills/ and it's picked up automatically.
   * No TypeScript or recompilation needed for simple gameplay rules.
   */
  skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname)
});`

  const lookSkill = {
    id: "look",
    description: "Observe your immediate surroundings",
    dmPromptExtension: "The player can 'look' to see their current location and nearby details.",
    resolve: "deterministic",
    outcome: {
      message: "You look around and take in your surroundings.",
      suggestedActions: [
        { id: "look", label: "Look again", prompt: "look around once more" }
      ]
    }
  };

  const loreReadme = `# Lore Files

Add markdown files to this directory for detailed world building.

Each .md file will be loaded and injected into the DM's system prompt.

## Suggested files

- factions.md — Organizations, guilds, political powers
- locations.md — Notable places, geography
- history.md — Timeline of major events
- cultures.md — Societies, customs, religions
- magic.md — Detailed magic system description

## Format

Use markdown headers to organize content:

\`\`\`markdown
# Factions

## The Iron Order
A group of... 
\`\`\`
`;

  const dmConfigTs = `import type { DungeonMasterModuleConfig } from "@opendungeon/content-sdk";

/**
 * DM Configuration
 * 
 * Controls how the Dungeon Master behaves.
 * Uncomment and modify as needed, or leave as-is for defaults.
 */
export const dmConfig: DungeonMasterModuleConfig = {
  // Base prompt — customize to set tone and style
  // systemPrompt: "You are a helpful Dungeon Master...",

  // Prompt template with variable substitution
  // promptTemplate: {
  //   lines: [
  //     "You are the DM for {{campaignTitle}}.",
  //     "Tone: dark fantasy, terse, atmospheric."
  //   ]
  // },

  // Guardrails — control output limits
  // guardrails: {
  //   maxSuggestedActions: 4,
  //   maxSummaryChars: 240
  // },

  // Tool policy — which DM tools are allowed
  // toolPolicy: {
  //   allowedTools: ["update_world_state", "set_summary", "set_suggested_actions"],
  //   requireSummary: true,
  //   requireSuggestedActions: true
  // },

  // Default suggested actions shown to players
  // defaultSuggestedActions: [
  //   { id: "look", label: "Look Around", prompt: "look around carefully" }
  // ]
};
`;

  const classesTs = `import type { CharacterTemplate } from "@opendungeon/content-sdk";

/**
 * Character Classes
 * 
 * Define available character classes and their starting stats.
 * Modify or add new classes as needed.
 */

export const availableClasses = ["Adventurer"];

const templates: Record<string, CharacterTemplate> = {
  Adventurer: {
    level: 1,
    hp: 100,
    attributes: {
      strength: 10,
      agility: 10,
      intellect: 10
    }
  }
  // Add more classes:
  // Warrior: { level: 1, hp: 130, attributes: { strength: 14 } },
  // Mage: { level: 1, hp: 80, attributes: { intellect: 14 } },
};

export const getCharacterTemplate = (className: string): CharacterTemplate =>
  templates[className] ?? templates.Adventurer!;
`;

  const settingConfig = {
    "name": "",
    "description": "",
    "era": "",
    "realismLevel": "soft",
    "tone": "",
    "themes": [],
    "magicSystem": "",
    "taboos": [],
    "custom": {}
  };

  const readme = `# ${packageName}

Custom game module for OpenDungeon.

## Quick Start

This is a blank game module ready to customize. All required files are present with sensible defaults.

\`\`\`bash
# Install dependencies
npm install

# Build the module
npm run build

# Set the game module path in OpenDungeon .env.local:
# GAME_MODULE_PATH=${absTargetDir}

# Start OpenDungeon normally
\`\`\`

## Project Structure

\`\`\`
├── setting.json              # World bible (era, tone, themes, taboos)
├── lore/                     # Markdown lore files
│   └── README.md             # Guide for adding lore
├── skills/                   # Declarative JSON skills
│   └── look.json             # Example skill (observe surroundings)
├── src/
│   ├── index.ts              # Game module entry point
│   ├── content/
│   │   ├── dm-config.ts      # DM prompts and guardrails
│   │   └── classes.ts        # Character class definitions
│   └── mechanics/            # TypeScript mechanics (empty, add as needed)
├── manifest.json             # Module metadata
├── package.json
└── tsconfig.json
\`\`\`

## Customization Steps

### 1. Define Your Setting (\`setting.json\`)

The setting.json file establishes your world's base lore. Fill in the blanks:

\`\`\`json
{
  "name": "Your World Name",
  "description": "Brief world description...",
  "era": "Medieval",
  "realismLevel": "soft",
  "tone": "dark and mysterious",
  "themes": ["exploration", "survival"],
  "magicSystem": "How magic works...",
  "taboos": ["No teleportation", "No resurrections"],
  "custom": {
    "currency": "Gold pieces",
    "technology": "Medieval tech only"
  }
}
\`\`\`

**Fields:**
- \`name\`: Your world's name
- \`description\`: Brief overview
- \`era\`: Historical period (Medieval, Victorian, Cyberpunk, etc.)
- \`realismLevel\`: \`hard\` (gritty), \`soft\` (heroic), or \`cinematic\`
- \`tone\`: Narrative mood
- \`themes\`: Core story themes (array)
- \`magicSystem\`: How magic works (or leave empty)
- \`taboos\`: Things the DM should NEVER include
- \`custom\`: Any additional key-value pairs

### 2. Add Lore Files (\`lore/\`)

Create markdown files for detailed world building. Each .md file is loaded and injected into the DM prompt.

Suggested files:
- \`factions.md\` — Organizations, guilds, powers
- \`locations.md\` — Notable places, geography
- \`history.md\` — Timeline of major events
- \`cultures.md\` — Societies, customs, religions

See \`lore/README.md\` for format examples.

### 3. Add Skills (\`skills/\`)

Drop JSON files into \`skills/\` — they're automatically picked up. No TypeScript needed!

\`\`\`json
{
  "id": "rest",
  "description": "Rest to recover HP",
  "resolve": "deterministic",
  "validate": {
    "worldStateKey": "safeToRest",
    "failMessage": "Too dangerous to rest here."
  },
  "outcome": {
    "message": "You rest and recover.",
    "characterPatch": { "hp": 100 }
  }
}
\`\`\`

### 4. Customize DM (\`src/content/dm-config.ts\`)

Uncomment and modify sections to customize DM behavior.

### 5. Add Character Classes (\`src/content/classes.ts\`)

Define available classes and their starting stats.

### 6. Add Mechanics (\`src/mechanics/\`)

For complex logic, add TypeScript mechanics with hooks.

See the [game-example](../packages/game-example/) for a complete reference implementation.

## Working with the Game

- Edit any file and save
- The engine will use the latest version on next restart
- For skills: just drop a new .json file into \`skills/\`
- For mechanics: add to \`src/mechanics/\` and import in \`index.ts\`

Happy building! 🎲
`;

  const files = [
    { path: resolve(absTargetDir, "package.json"), content: JSON.stringify(packageJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "manifest.json"), content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: resolve(absTargetDir, "tsconfig.json"), content: JSON.stringify(tsconfig, null, 2) + "\n" },
    { path: resolve(absTargetDir, ".gitignore"), content: "node_modules\ndist\n" },
    { path: resolve(absTargetDir, "README.md"), content: readme },
    { path: resolve(absTargetDir, "src/index.ts"), content: indexTs },
    { path: resolve(absTargetDir, "src/content/dm-config.ts"), content: dmConfigTs },
    { path: resolve(absTargetDir, "src/content/classes.ts"), content: classesTs },
    { path: resolve(absTargetDir, "skills/look.json"), content: JSON.stringify(lookSkill, null, 2) + "\n" },
    { path: resolve(absTargetDir, "setting.json"), content: JSON.stringify(settingConfig, null, 2) + "\n" },
    { path: resolve(absTargetDir, "lore/README.md"), content: loreReadme }
  ];

  if (dryRun) {
    process.stdout.write(`Dry run: would write ${files.length} files to ${absTargetDir}\n`);
    for (const file of files) {
      process.stdout.write(`  - ${file.path}\n`);
    }
    return;
  }

  mkdirSync(resolve(absTargetDir, "src"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "src/content"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "src/mechanics"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "skills"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "lore"), { recursive: true });
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

  const contentSdkDependency = getContentSdkDependency(absTargetDir);
  createFiles({
    absTargetDir,
    packageName,
    contentSdkDependency,
    dryRun: options.dryRun
  });

  process.stdout.write(`Game module scaffold ready: ${absTargetDir}\n`);
  process.stdout.write(`Package name: ${packageName}\n`);
  process.stdout.write("Next steps:\n");
  process.stdout.write(`  1) cd ${absTargetDir} && npm install\n`);
  process.stdout.write(`  2) Set GAME_MODULE_PATH=${absTargetDir} in OpenDungeon .env.local\n`);
  process.stdout.write("  3) Start gateway/orchestrator\n");
};

run().catch((error) => {
  process.stderr.write(`create-game-module failed: ${String(error)}\n`);
  process.stderr.write("Run with --help for usage.\n");
  process.exit(1);
});
