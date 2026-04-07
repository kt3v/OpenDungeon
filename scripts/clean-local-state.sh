#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
KEEP_DB=0
DELETE_GAMES=0
DELETE_WEB=0

print_help() {
  cat <<'EOF'
OpenDungeon local state cleaner

Usage:
  ./scripts/clean-local-state.sh [--dry-run] [--keep-db] [--delete-games]

Options:
  --dry-run      Print actions without deleting/stopping anything
  --keep-db      Skip `docker compose down`
  --delete-games Delete all modules in the games/ directory
  --delete-web   Delete all web UI modules in the web/ directory
  -h, --help     Show help
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
    --delete-games)
      DELETE_GAMES=1
      ;;
    --delete-web)
      DELETE_WEB=1
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
run_cmd "rm -f .env"
run_cmd "rm -f .env.local"
run_cmd "rm -rf .turbo"
run_cmd "rm -rf .next"
run_cmd "find . -type d -name dist -prune -exec rm -rf {} +"
run_cmd "find . -type f -name '*.tsbuildinfo' -delete"

if [[ "$DELETE_GAMES" -eq 1 ]]; then
  echo "Deleting user game projects in games/..."
  run_cmd "rm -rf games"
else
  echo "Keeping user game projects in games/ (use --delete-games to wipe them)"
fi

if [[ "$DELETE_WEB" -eq 1 ]]; then
  echo "Deleting web UI modules in web/..."
  run_cmd "rm -rf web"
else
  echo "Keeping web UI modules in web/ (use --delete-web to wipe them)"
fi

echo "Done. Reinstall manually when needed:"
echo "  npm install"
echo "  npm run setup"
echo "  npm run dev:full"
