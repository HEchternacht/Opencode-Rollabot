# Opencode-Rollabot

Opencode plugin that enforces a **design → build pipeline**, runs **smoke tests on every file write**, syncs a persistent **todo list**, and shows **toast notifications** for everything.

## What it does

- **`create_design` tool** — AI fills structured args (goal, stack, features, structure, steps, notes) → plugin writes `design.md` + `todo.md` instantly, no LLM generation cost
- **Clarifying questions** — AI uses the `question` tool (not plain text) before calling `create_design`, so all requirements are gathered upfront in a single structured call
- **`todowrite` sync** — every time the AI calls `todowrite`, the plugin mirrors the state to `todo.md` with `[x]`/`[~]`/`[ ]` status icons; session resume reads both files to continue from where it stopped
- **design.md gate** — blocks all code writes and todo creation until `design.md` exists
- **Smoke tests** — run automatically after every code file write (Python, JS, TS, React, Rust, Go, Ruby)
- **Toast notifications** — status for every key event (smoke pass/fail, file written, agent switches, blocks)
- **Rules injection** — injects `reminder.md` into every LLM call via the message transform hook (TUI never sees it); edit live, no restart needed
- **Cavemode** (`/cm`) — maximum info density, strips all filler words from AI responses
- **Smart mode** (`/smart`) — AI writes out its step-by-step plan visibly before executing

## Install

### Windows
```powershell
git clone https://github.com/HEchternacht/Opencode-Rollabot
cd Opencode-Rollabot
.\install.ps1
```

### Linux / macOS / WSL
```bash
git clone https://github.com/HEchternacht/Opencode-Rollabot
cd Opencode-Rollabot
bash install.sh
```

Restart opencode after install.

## Commands

| Command | What it does |
|---------|-------------|
| `/design [prompt]` | Toggle design+smoke pipeline on/off. When on and `design.md` is missing, AI asks clarifying questions via the `question` tool, then calls `create_design` |
| `/smart [task]` | AI writes its reasoning plan visibly before executing |
| `/cm` | Toggle cavemode — zero filler, maximum density |

## Pipeline

```
/design
  → AI asks ALL clarifying questions (question tool, single call)
  → user answers
  → AI calls create_design(goal, stack, features, structure, steps, notes)
  → plugin writes design.md + todo.md instantly
  → AI calls todowrite → visual todo list appears in TUI + todo.md synced
  → AI implements step by step, following design.md
  → after each code file: smoke test runs automatically
  → todowrite on every status change → todo.md stays in sync
  → next session: AI reads design.md + todo.md → resumes from last in-progress item
```

## Session resume

When `/design` is active and `design.md` exists, the injection on first message tells the AI to read both `design.md` and `todo.md` before doing anything. It then calls `todowrite` to restore its internal state and continues from the last in-progress item.

## Customize rules

Edit `~/.config/opencode/plugins/rollabot/reminder.md` — changes apply to the next message, no restart needed.

## Files installed

| Path | Purpose |
|------|---------|
| `~/.config/opencode/plugins/rollabot/index.ts` | Plugin — all hooks, `create_design` tool, smoke tracking, toasts |
| `~/.config/opencode/plugins/rollabot/reminder.md` | Rules injected into every LLM call |
| `~/.config/opencode/agents/smoker.md` | Smoker subagent — runs smoke tests, reports `SMOKE:PASS` / `SMOKE:FAIL` |
| `~/.config/opencode/commands/design.md` | `/design` command |
| `~/.config/opencode/commands/smart.md` | `/smart` command |
| `~/.config/opencode/commands/cm.md` | `/cm` cavemode toggle |

## Smoke test format

| Language | Test location | Run command |
|----------|--------------|-------------|
| Python | `if __name__ == "__main__":` block | `python "file.py"` |
| JS | `if (require.main === module)` block | `node "file.js"` |
| TS | `if (import.meta.main)` block | `npx tsx "file.ts"` |
| React | `file.smoke.tsx` alongside | `npx tsx "file.smoke.tsx"` |
| Rust | `#[cfg(test)] fn smoke()` | `cargo test smoke` |
| Go | `func TestSmoke` in `_test.go` | `go test -run TestSmoke` |
