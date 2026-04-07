# Opencode-Rollabot

Opencode plugin that enforces a **designer → build pipeline**, runs **smoke tests on every file write**, and shows **toast notifications** for everything.

## What it does

- **@designer subagent** — reads codebase, reasons about implementation, writes plans to `design.md` (signatures + pseudo-code only, no real code)
- **design.md gate** — blocks all code writes and todo creation until `design.md` exists and has content
- **Smoke tests** — runs automatically after every code file write (Python, JS, TS, React, Rust, Go, Ruby)
- **Toast notifications** — shows status for every key event (smoke pass/fail, design.md written, agent switches, blocks)
- **Rules injection** — injects `reminder.md` into every LLM call (edit it live, no restart needed)
- **Reasoning enforcement** — all reasoning must be in `<think>...</think>` tags, minimum depth enforced

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

## Customize rules

Edit `~/.config/opencode/plugins/rollabot/reminder.md` — changes apply immediately, no restart needed.

## Files installed

| Path | Purpose |
|------|---------|
| `~/.config/opencode/plugins/rollabot/index.ts` | Plugin (hooks, smoke tests, toasts) |
| `~/.config/opencode/plugins/rollabot/reminder.md` | Editable rules injected every LLM call |
| `~/.config/opencode/agents/designer.md` | Designer subagent definition |

## Pipeline

```
User prompt
  → build agent gathers requirements
  → calls @designer → designer writes design.md
  → build agent reads design.md, implements step by step
  → after each file write: smoke test runs automatically
  → toast shows pass/fail
```

## Smoke test format (per language)

| Language | Test location | Run command |
|----------|--------------|-------------|
| Python | `if __name__ == "__main__":` block | `python "file.py"` |
| JS | `if (require.main === module)` block | `node "file.js"` |
| TS | `if (import.meta.main)` block | `npx tsx "file.ts"` |
| React | `file.smoke.tsx` alongside | `npx tsx "file.smoke.tsx"` |
| Rust | `#[cfg(test)] fn smoke()` | `cargo test smoke` |
| Go | `func TestSmoke` in `_test.go` | `go test -run TestSmoke` |
