#!/usr/bin/env bash
# Copies build output from this repo into the Obsidian vault's plugin folder.
# One-way: repo -> vault. Never edit inside the vault plugin folder directly
# (keeps code-in-repo / memory-in-vault separation, and Syncthing then
# propagates the vault copy to every device).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT_PLUGIN_DIR="$HOME/obsidian-vault/.obsidian/plugins/lilac"

mkdir -p "$VAULT_PLUGIN_DIR"

cp "$REPO_DIR/main.js" "$VAULT_PLUGIN_DIR/"
cp "$REPO_DIR/manifest.json" "$VAULT_PLUGIN_DIR/"
cp "$REPO_DIR/styles.css" "$VAULT_PLUGIN_DIR/"
cp "$REPO_DIR/node_modules/sql.js/dist/sql-wasm.wasm" "$VAULT_PLUGIN_DIR/"

echo "deployed to $VAULT_PLUGIN_DIR"
ls -la "$VAULT_PLUGIN_DIR"
