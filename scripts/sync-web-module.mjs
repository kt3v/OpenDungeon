import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const rootDir = process.cwd();
const sourceDir = resolve(rootDir, "apps", "web");
const envPath = resolve(rootDir, ".env.local");
const args = process.argv.slice(2);
const force = args.includes("--force");

const SKIP = new Set(["node_modules", ".turbo", "dist", "tsconfig.tsbuildinfo"]);

const parseEnvFile = (filePath) => {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
};

const shouldSkip = (entryName) => SKIP.has(entryName);

const buffersEqual = (a, b) => a.length === b.length && a.equals(b);

const copyTree = (src, dst, stats) => {
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;

    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);

    if (entry.isDirectory()) {
      if (!existsSync(dstPath)) {
        mkdirSync(dstPath, { recursive: true });
      }
      copyTree(srcPath, dstPath, stats);
      continue;
    }

    if (!entry.isFile()) continue;

    if (!existsSync(dstPath)) {
      mkdirSync(resolve(dstPath, ".."), { recursive: true });
      copyFileSync(srcPath, dstPath);
      stats.copied += 1;
      continue;
    }

    const srcStat = statSync(srcPath);
    const dstStat = statSync(dstPath);
    if (srcStat.size === dstStat.size) {
      const srcBuf = readFileSync(srcPath);
      const dstBuf = readFileSync(dstPath);
      if (buffersEqual(srcBuf, dstBuf)) {
        stats.unchanged += 1;
        continue;
      }
    }

    if (force) {
      copyFileSync(srcPath, dstPath);
      stats.overwritten += 1;
    } else {
      stats.skippedChanged += 1;
    }
  }
};

const env = parseEnvFile(envPath);
const webModulePath = env.WEB_MODULE_PATH;

if (!webModulePath) {
  process.stderr.write("WEB_MODULE_PATH is not set in .env.local\n");
  process.exit(1);
}

const targetDir = resolve(rootDir, webModulePath);

if (!existsSync(sourceDir)) {
  process.stderr.write("Template directory not found: apps/web\n");
  process.exit(1);
}

if (!existsSync(targetDir)) {
  process.stderr.write(`WEB_MODULE_PATH does not exist: ${targetDir}\n`);
  process.exit(1);
}

const stats = { copied: 0, overwritten: 0, unchanged: 0, skippedChanged: 0 };
copyTree(sourceDir, targetDir, stats);

process.stdout.write(`Synced template from apps/web → ${relative(rootDir, targetDir) || webModulePath}\n`);
process.stdout.write(`Copied new files: ${stats.copied}\n`);
process.stdout.write(`Overwritten files: ${stats.overwritten}\n`);
process.stdout.write(`Unchanged files: ${stats.unchanged}\n`);
if (!force) {
  process.stdout.write(`Skipped changed files: ${stats.skippedChanged} (use --force to overwrite)\n`);
}
