#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
KEEP_DB=0

print_help() {
  cat <<'EOF'
OpenDungeon local state cleaner

Usage:
  ./scripts/clean-local-state.sh [--dry-run] [--keep-db]

Options:
  --dry-run   Print actions without deleting/stopping anything
  --keep-db   Skip `docker compose down`
  -h, --help  Show this help

What gets cleaned:
  - docker compose services with volumes (unless --keep-db)
  - node_modules/
  - package-lock.json
  - .env.local
  - .turbo/
  - .next/
  - all dist/ directories
  - all *.tsbuildinfo files

This script does NOT run npm install/setup/dev.
EOF
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
    return 0
  fi
  eval "$*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --keep-db)
      KEEP_DB=1
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_help
      exit 1
      ;;
  esac
  shift
done

cd "$ROOT_DIR"

echo "Cleaning local OpenDungeon state in: $ROOT_DIR"

if [[ "$KEEP_DB" -eq 0 ]]; then
  run_cmd "docker compose down -v"
else
  echo "Skipping docker compose down (--keep-db)"
fi

run_cmd "rm -rf node_modules"
run_cmd "rm -f package-lock.json"
run_cmd "rm -f .env.local"
run_cmd "rm -rf .turbo"
run_cmd "rm -rf .next"
run_cmd "find . -type d -name dist -prune -exec rm -rf {} +"
run_cmd "find . -type f -name '*.tsbuildinfo' -delete"

echo "Done. Reinstall manually when needed:"
echo "  npm install"
echo "  npm run setup"
echo "  npm run dev:full"
