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
      "skills"
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

  const indexTs = `import { defineGameModule, loadSkillsDirSync } from "@opendungeon/content-sdk";

const manifest = ${JSON.stringify(manifest, null, 2)};

export default defineGameModule({
  manifest,

  initial: {
    /** Returns the world state for a brand-new campaign. */
    worldState: () => ({
      location: "dungeon_entrance"
    })
  },

  characters: {
    availableClasses: ["Adventurer"],
    getTemplate: () => ({
      level: 1,
      hp: 100,
      attributes: { strength: 10, agility: 10, intellect: 10 }
    })
  },

  dm: {
    /** Base prompt for the Dungeon Master. */
    systemPrompt: "You are the Dungeon Master for a custom OpenDungeon module. Tone: dark and mysterious.",
    /** Guardrails to keep the DM's JSON output stable. */
    guardrails: {
      maxSuggestedActions: 4,
      maxSummaryChars: 240
    }
  },

  /** TypeScript mechanics — use for complex state logic and hooks. */
  mechanics: [],

  /** 
   * Declarative skills — drop a .json file into skills/ and it's picked up automatically.
   * No TypeScript or recompilation needed for simple gameplay rules.
   */
  skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname)
});
`;

  const lookSkill = {
    id: "look",
    description: "Observe your immediate surroundings",
    dmPromptExtension: "The player can 'look' to see their current location and nearby details.",
    resolve: "deterministic",
    outcome: {
      message: "You scan your surroundings. The air is cold and damp, but you see a faint glimmer of light ahead.",
      worldPatch: { lastObservation: "glimmer_of_light" },
      suggestedActions: [
        { id: "look", label: "Look again", prompt: "look around once more" },
        { id: "advance", label: "Move toward light", prompt: "walk toward the glimmering light" }
      ]
    }
  };

  const readme = `# ${packageName}

Custom game module for OpenDungeon.

## Structure

- \`skills/\`: Declarative JSON skills (no TypeScript needed).
- \`src/\`: TypeScript mechanics and module entry point.
- \`manifest.json\`: Module metadata.

## Usage

1. Install dependencies in this module folder:

\`npm install\`

2. Set \`GAME_MODULE_PATH\` in OpenDungeon \`.env\`:

\`GAME_MODULE_PATH=${absTargetDir}\`

3. Start OpenDungeon normally.
`;

  const files = [
    { path: resolve(absTargetDir, "package.json"), content: JSON.stringify(packageJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "manifest.json"), content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: resolve(absTargetDir, "tsconfig.json"), content: JSON.stringify(tsconfig, null, 2) + "\n" },
    { path: resolve(absTargetDir, ".gitignore"), content: "node_modules\ndist\n" },
    { path: resolve(absTargetDir, "README.md"), content: readme },
    { path: resolve(absTargetDir, "src/index.ts"), content: indexTs },
    { path: resolve(absTargetDir, "skills/look.json"), content: JSON.stringify(lookSkill, null, 2) + "\n" }
  ];

  if (dryRun) {
    process.stdout.write(`Dry run: would write ${files.length} files to ${absTargetDir}\n`);
    for (const file of files) {
      process.stdout.write(`  - ${file.path}\n`);
    }
    return;
  }

  mkdirSync(resolve(absTargetDir, "src"), { recursive: true });
  mkdirSync(resolve(absTargetDir, "skills"), { recursive: true });
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
