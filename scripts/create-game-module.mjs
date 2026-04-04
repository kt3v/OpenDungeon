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

  const contentConfig = `export const contentConfig = {
  dungeonMasterPrompt: {
    lines: [
      "You are the Dungeon Master for a custom OpenDungeon module.",
      "Tone: concise, vivid, and actionable.",
      "Campaign Title: {{campaignTitle}}.",
      "Output: valid JSON only with keys message, optional worldPatch, optional summaryPatch, optional suggestedActions."
    ]
  },
  initialCampaignState: {
    location: "starting_point"
  },
  classes: {
    Adventurer: { level: 1, hp: 100, attributes: { agility: 10, strength: 10, intellect: 10 } }
  },
  fallbackClass: { level: 1, hp: 100, attributes: { agility: 10, strength: 10, intellect: 10 } },
  actionRules: {
    look: {
      message: "You pause and scan your surroundings.",
      worldPatch: { lastObservation: "unknown" }
    }
  },
  suggestedActions: [
    { id: "look", label: "Look Around", prompt: "look around" },
    { id: "move", label: "Move Forward", prompt: "move forward carefully" },
    { id: "listen", label: "Listen", prompt: "listen closely" }
  ],
  toolPolicy: {
    allowedTools: ["update_world_state", "set_summary", "set_suggested_actions"],
    requireSummary: true,
    requireSuggestedActions: true
  },
  guardrails: {
    maxSuggestedActions: 4,
    maxSummaryChars: 220
  },
  suggestedActionStrategy: ({ state }: { state: Record<string, unknown> }) => {
    const base = [
      { id: "advance", label: "Advance", prompt: "advance carefully" },
      { id: "investigate", label: "Investigate", prompt: "inspect nearby details" }
    ];

    if (typeof state.lastObservation === "string" && state.lastObservation.trim()) {
      base.unshift({
        id: "focus",
        label: "Focus on " + state.lastObservation,
        prompt: "inspect " + state.lastObservation
      });
    }

    return base.slice(0, 4);
  }
} as const;
`;

  const indexTs = `import { defineGameModule, renderDungeonMasterPromptTemplate } from "@opendungeon/content-sdk";
import { contentConfig } from "./content-config.js";

const manifest = ${JSON.stringify(manifest, null, 2)};

const moduleDef = defineGameModule({
  manifest,
  getInitialCampaignState() {
    return { ...contentConfig.initialCampaignState };
  },
  getCharacterTemplate({ className }) {
    return contentConfig.classes[className as keyof typeof contentConfig.classes] ?? contentConfig.fallbackClass;
  },
  getSuggestedActions() {
    return [...contentConfig.suggestedActions];
  },
  getDungeonMasterSystemPrompt(input) {
    return renderDungeonMasterPromptTemplate(contentConfig.dungeonMasterPrompt, input);
  },
  getDungeonMasterConfig() {
    return {
      promptTemplate: contentConfig.dungeonMasterPrompt,
      guardrails: contentConfig.guardrails,
      toolPolicy: contentConfig.toolPolicy,
      defaultSuggestedActions: contentConfig.suggestedActions,
      suggestedActionStrategy: contentConfig.suggestedActionStrategy
    };
  },
  async onPlayerAction(ctx) {
    const action = ctx.actionText.trim().toLowerCase();

    if (action.includes("look")) {
      return {
        message: contentConfig.actionRules.look.message,
        worldPatch: contentConfig.actionRules.look.worldPatch
      };
    }

    return {
      message: "Action noted: " + ctx.actionText
    };
  }
});

export default moduleDef;
`;

  const readme = `# ${packageName}

Custom game module for OpenDungeon.

## Usage

1. Install dependencies in this module folder:

\`npm install\`

2. Set \`GAME_MODULE_PATH\` in OpenDungeon \`.env.local\`:

\`GAME_MODULE_PATH=${absTargetDir}\`

3. Start OpenDungeon gateway/orchestrator normally.
`;

  const files = [
    { path: resolve(absTargetDir, "package.json"), content: JSON.stringify(packageJson, null, 2) + "\n" },
    { path: resolve(absTargetDir, "manifest.json"), content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: resolve(absTargetDir, "tsconfig.json"), content: JSON.stringify(tsconfig, null, 2) + "\n" },
    { path: resolve(absTargetDir, ".gitignore"), content: "node_modules\ndist\n" },
    { path: resolve(absTargetDir, "README.md"), content: readme },
    { path: resolve(absTargetDir, "src/content-config.ts"), content: contentConfig },
    { path: resolve(absTargetDir, "src/index.ts"), content: indexTs }
  ];

  if (dryRun) {
    process.stdout.write(`Dry run: would write ${files.length} files to ${absTargetDir}\n`);
    for (const file of files) {
      process.stdout.write(`  - ${file.path}\n`);
    }
    return;
  }

  mkdirSync(resolve(absTargetDir, "src"), { recursive: true });
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
