#!/usr/bin/env bash
# Rollabot — Linux / macOS / WSL Install Script
# Run from the repo root: bash install.sh
set -e

CONFIG_DIR="$HOME/.config/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins/rollabot"
AGENTS_DIR="$CONFIG_DIR/agents"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

echo "[Rollabot] Installing..."

mkdir -p "$PLUGIN_DIR"
mkdir -p "$AGENTS_DIR"

cp index.ts    "$PLUGIN_DIR/index.ts"
cp reminder.md "$PLUGIN_DIR/reminder.md"
echo "[Rollabot] Plugin files copied to $PLUGIN_DIR"

cp agents/*.md "$AGENTS_DIR/"
echo "[Rollabot] Agent files copied to $AGENTS_DIR"

PLUGIN_PATH="$PLUGIN_DIR/index.ts"

if [ -f "$CONFIG_FILE" ]; then
    if command -v node &>/dev/null; then
        node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
if (!c.plugin) c.plugin = [];
if (!c.plugin.includes('$PLUGIN_PATH')) c.plugin.push('$PLUGIN_PATH');
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(c, null, 2));
"
        echo "[Rollabot] Registered in opencode.json"
    elif command -v python3 &>/dev/null; then
        python3 -c "
import json
with open('$CONFIG_FILE') as f: c = json.load(f)
if 'plugin' not in c: c['plugin'] = []
if '$PLUGIN_PATH' not in c['plugin']: c['plugin'].append('$PLUGIN_PATH')
with open('$CONFIG_FILE', 'w') as f: json.dump(c, f, indent=2)
"
        echo "[Rollabot] Registered in opencode.json"
    else
        echo "[Rollabot] WARNING: node/python3 not found. Add manually to opencode.json:"
        echo "  \"plugin\": [\"$PLUGIN_PATH\"]"
    fi
else
    echo "[Rollabot] WARNING: opencode.json not found at $CONFIG_FILE. Add manually:"
    echo "  \"plugin\": [\"$PLUGIN_PATH\"]"
fi

echo "[Rollabot] Done. Restart opencode."
