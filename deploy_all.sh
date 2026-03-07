#!/usr/bin/env bash
#============================================================
#  Bormagi Extension — Build, Package and Install (Linux)
#============================================================
#
#  Usage:
#     ./deploy_all.sh [extension_dir] [workspace_to_open]
#============================================================

set -euo pipefail   # exit on first error, undefined var, or pipeline error
IFS=$'\n\t'         # safer word-splitting

# ── 0. Resolve extension directory ────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${1:-$SCRIPT_DIR}"
WORKSPACE_TO_OPEN="${2:-$PWD}"

if [[ ! -d "$EXT_DIR" ]]; then
  printf "\nERROR: Extension directory not found:\n  %s\n\n" "$EXT_DIR"
  exit 1
fi

EXT_DIR="$(cd "$EXT_DIR" && pwd)"

if [[ ! -f "$EXT_DIR/package.json" ]]; then
  printf "\nERROR: package.json not found in extension directory:\n  %s\n\n" "$EXT_DIR"
  exit 1
fi

if command -v code >/dev/null 2>&1; then
  CODE_CMD="code"
elif command -v code-insiders >/dev/null 2>&1; then
  CODE_CMD="code-insiders"
else
  printf "\nERROR: VS Code CLI not found. Install 'code' or 'code-insiders' in PATH.\n\n"
  exit 1
fi


printf "\n=============================================================\n"
printf " Bormagi Extension — Build, Package and Install (Linux)\n"
printf "=============================================================\n\n"

pushd "$EXT_DIR" >/dev/null

# ── 1. Install / refresh dependencies ─────────────────────────
printf "[1/4] Installing npm dependencies…\n"
npm install
printf "Done.\n\n"

# ── 2. Compile (webpack) ──────────────────────────────────────
printf "[2/4] Compiling extension (webpack)…\n"
npm run compile
printf "Done.\n\n"

# ── 3. Package with vsce ──────────────────────────────────────
printf "[3/4] Packaging extension (.vsix)…\n"
npm run vsce:package
printf "Done.\n\n"

# Locate the newest .vsix produced by vsce
VSIX_FILE="$(ls -t *.vsix 2>/dev/null | head -n 1 || true)"

if [[ -z "$VSIX_FILE" ]]; then
  printf "ERROR: No .vsix file found after packaging.\n"
  popd >/dev/null
  exit 1
fi

printf "Packaged: %s\n\n" "$VSIX_FILE"

# ── 4. Install into VS Code ───────────────────────────────────
printf "[4/4] Installing extension into VS Code…\n"
"$CODE_CMD" --install-extension "$EXT_DIR/$VSIX_FILE" --force
printf "Done.\n\n"

# Verify extension is installed in regular VS Code profile.
EXT_ID="$(node -p "const p=require('./package.json'); (p.publisher + '.' + p.name).toLowerCase()")"
if "$CODE_CMD" --list-extensions | tr '[:upper:]' '[:lower:]' | grep -qx "$EXT_ID"; then
  printf "Installed extension id: %s\n\n" "$EXT_ID"
else
  printf "WARNING: Could not verify installed extension id: %s\n\n" "$EXT_ID"
fi

popd >/dev/null

printf "=============================================================\n"
printf " SUCCESS — Bormagi installed from %s\n" "$VSIX_FILE"
printf " Bormagi stays installed and enabled in normal VS Code sessions.\n"
printf " Reload VS Code (Ctrl+Shift+P -> Developer: Reload Window) if already open.\n"
printf "=============================================================\n\n"

printf "Opening regular VS Code window: %s\n" "$WORKSPACE_TO_OPEN"
"$CODE_CMD" "$WORKSPACE_TO_OPEN" >/dev/null 2>&1 || true
