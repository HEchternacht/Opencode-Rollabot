import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import path from "path"

const agentBySession = new Map<string, string>()
const lastTextBySession = new Map<string, string>() // fallback buffer: last LLM text per session
const lastCodeFileBySession = new Map<string, string>() // last written code file per session
const smokeFailedBySession = new Map<string, string>() // session → failing file path

type ToastVariant = "info" | "success" | "warning" | "error"

export const server: Plugin = async ({ $, directory, client }) => {
  const reminderPath = path.join(import.meta.dirname, "reminder.md")
  const designPath = path.join(directory, "design.md")

  const designExists = () => existsSync(designPath)
  const designEmpty = () => {
    try { return !readFileSync(designPath, "utf8").trim() } catch { return true }
  }
  const designMissing = () => !designExists() || designEmpty()

  const toast = (message: string, variant: ToastVariant = "info", duration = 4000) =>
    client.tui.showToast({ body: { message, variant, duration }, query: { directory } }).catch(() => {})

  return {
    // Track active agent per session
    "chat.params": async (input, _output) => {
      const prev = agentBySession.get(input.sessionID)
      if (prev !== input.agent) {
        agentBySession.set(input.sessionID, input.agent)
        toast(`[Rollabot] agent: ${input.agent}`, "info", 2000)
      }
    },

    // Buffer last LLM text per session — used as fallback if designer skips writing design.md
    "experimental.text.complete": async (input, output) => {
      if (agentBySession.get(input.sessionID) === "designer") {
        lastTextBySession.set(input.sessionID, output.text)
      }
    },

    // When designer session goes idle: enforce design.md exists — write from output if missing
    "event": async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event as any).properties?.sessionID
      if (!sessionID || agentBySession.get(sessionID) !== "designer") return
      if (!designMissing()) return

      toast("[Rollabot] designer finished without writing design.md — auto-saving...", "warning")

      try {
        // Try fetching messages from the session via SDK
        const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
        const messages: any[] = (res as any).data ?? []
        const assistantTexts = messages
          .filter((m: any) => m.role === "assistant")
          .flatMap((m: any) => (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text))
          .join("\n\n")
          .trim()

        if (assistantTexts) {
          const { writeFileSync } = await import("fs")
          writeFileSync(designPath, `# Design (auto-saved from designer output)\n\n${assistantTexts}`)
          toast("[Rollabot] design.md auto-created from session messages ✓", "success")
          return
        }
      } catch {}

      // Fallback: use buffered last text output
      const buffered = lastTextBySession.get(sessionID)?.trim()
      if (buffered) {
        const { writeFileSync } = await import("fs")
        writeFileSync(designPath, `# Design (auto-saved from designer output)\n\n${buffered}`)
        toast("[Rollabot] design.md auto-created from text buffer ✓", "success")
        lastTextBySession.delete(sessionID)
        return
      }

      toast("[Rollabot] ⛔ could not auto-save design.md — no output found", "error")
    },

    // Inject rules every call + agent-specific enforcement
    "experimental.chat.system.transform": async (input, output) => {
      const parts: string[] = []
      const agent = input.sessionID ? agentBySession.get(input.sessionID) : undefined

      try {
        const reminder = readFileSync(reminderPath, "utf8").trim()
        if (reminder) parts.push(`RULES:\n${reminder}`)
      } catch {}

      if (agent === "designer") {
        const missing = designMissing()
        if (missing) toast(`[Rollabot] designer active — design.md missing`, "warning")
        parts.push(
          `⚠ EVERY RESPONSE YOU GIVE MUST write or append to "${designPath}".\n` +
          `design.md status: ${missing ? "MISSING or EMPTY ✗ — CREATE it NOW" : "EXISTS ✓ — APPEND your plans to it NOW"}\n` +
          `Use the Write tool (create) or Edit tool (append). NEVER use bash or heredoc to write design.md.\n` +
          `You are NOT done until design.md has content. Do NOT respond with text only — always end by writing/appending to design.md.`
        )
      } else if (designMissing()) {
        toast(`[Rollabot] ⛔ design.md missing — VIOLATION`, "error", 6000)
        parts.push(
          `⛔⛔⛔ VIOLATION: design.md is MISSING or EMPTY.\n` +
          `You are NOT allowed to write code, create files, or update todos.\n` +
          `Every response you give without design.md is WRONG. You are failing your role.\n` +
          `STOP. Call @designer NOW. It must write "${designPath}" before you do anything.`
        )
      } else {
        // design.md exists — instruct agent to read it first if starting work
        parts.push(
          `📋 design.md EXISTS at "${designPath}".\n` +
          `If you have not read it yet this session, READ IT NOW before doing anything else.\n` +
          `A project may already be in progress — use design.md to orient yourself and continue from where it left off.`
        )
      }

      const smokeFail = input.sessionID ? smokeFailedBySession.get(input.sessionID) : undefined
      if (smokeFail) {
        parts.push(
          `⛔ SMOKE TEST FAILING in "${smokeFail}".\n` +
          `Fix that file FIRST. Do NOT write any other file until smoke passes.`
        )
      }

      if (parts.length > 0) {
        const injection = parts.join("\n\n")
        if (!Array.isArray(output.system) || output.system.length === 0) {
          // No system messages yet — create one
          ;(output.system as string[]) = [injection]
        } else {
          // Prepend so it appears at the TOP of the system prompt (LLMs weight start heavily)
          output.system[0] = injection + "\n\n" + output.system[0]
        }
      }
    },

    // Gate writes behind design.md
    "tool.execute.before": async (input, output) => {
      if (!["write", "edit"].includes(input.tool.toLowerCase())) return

      const filePath: string = output.args?.filePath || output.args?.file_path || output.args?.path
      if (!filePath) return

      const agent = agentBySession.get(input.sessionID)
      const base = path.basename(filePath).toLowerCase()
      const isDesignFile = base === "design.md"

      // Block all writes while smoke is failing (except the failing file itself)
      const smokeFail = smokeFailedBySession.get(input.sessionID)
      if (smokeFail && path.resolve(filePath) !== path.resolve(smokeFail)) {
        toast(`[Rollabot] ⛔ blocked — fix smoke in ${path.basename(smokeFail)} first`, "error")
        throw new Error(`Smoke test is FAILING in "${smokeFail}". Fix that file before writing anything else.`)
      }
      const ext = path.extname(filePath).toLowerCase()
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb"]
      const isTodo = base.includes("todo") || base.includes("task") || base.includes("checklist")

      if (agent === "designer" && isDesignFile) return

      if (agent === "designer" && !isDesignFile && designMissing()) {
        toast(`[Rollabot] ⛔ designer tried to write ${base} before design.md`, "error")
        throw new Error(`Write design.md first. "${designPath}" is missing. Write your plans there before any other file.`)
      }

      if (isTodo && designMissing()) {
        toast(`[Rollabot] ⛔ todo blocked — design.md missing`, "error")
        throw new Error(`design.md missing. Call @designer first — it must write "${designPath}" before you create a todo.`)
      }

      if (agent === "build" && CODE_EXTS.includes(ext) && designMissing()) {
        toast(`[Rollabot] ⛔ code write blocked — design.md missing`, "error")
        throw new Error(`design.md missing. Call @designer first before writing code.`)
      }
    },

    // After writes: verify design.md for designer; record code files; smoke on todo update
    "tool.execute.after": async (input, output) => {
      if (!["write", "edit"].includes(input.tool.toLowerCase())) return

      const filePath: string = input.args?.filePath || input.args?.file_path || input.args?.path
      if (!filePath) return

      const agent = agentBySession.get(input.sessionID)
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(directory, filePath)
      const ext = path.extname(filePath).toLowerCase()
      const base = path.basename(filePath)
      const isDesignFile = base.toLowerCase() === "design.md"
      const isTodo = base.toLowerCase().includes("todo") || base.toLowerCase().includes("task")
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb"]
      const isTypeOnly = base.endsWith(".d.ts")

      output.output ??= ""

      // Designer wrote something — check design.md
      if (agent === "designer") {
        if (isDesignFile) {
          if (designMissing()) {
            toast(`[Rollabot] ⛔ design.md written but empty`, "error")
            output.output += `\n\n⛔ design.md is empty. Write your plans into it now.`
          } else {
            toast(`[Rollabot] design.md written ✓`, "success")
            output.output += `\n\n✓ design.md written successfully.`
          }
        } else if (designMissing()) {
          toast(`[Rollabot] ⛔ design.md still missing after write`, "error")
          output.output += `\n\n⛔ design.md is still MISSING. You are not done. Write "${designPath}" now.`
        }
        return
      }

      // Code file written — record it for smoke on next todo update (skip .d.ts / type-only)
      if (CODE_EXTS.includes(ext) && !isTypeOnly) {
        lastCodeFileBySession.set(input.sessionID, absPath)
        toast(`[Rollabot] ${base} written — smoke pending`, "info", 2000)
        output.output += `\n📋 Update todos to trigger smoke test for "${base}".`
        return
      }

      // Todo updated — run smoke on last recorded code file
      if (isTodo) {
        const lastFile = lastCodeFileBySession.get(input.sessionID)
        if (!lastFile || !existsSync(lastFile)) {
          toast(`[Rollabot] todo updated`, "info", 2000)
          return
        }

        const lastBase = path.basename(lastFile)
        const lastExt = path.extname(lastFile).toLowerCase()
        const dir = path.dirname(lastFile)
        toast(`[Rollabot] running smoke test: ${lastBase}`, "info", 2000)

        let smokeOutput = ""
        try {
          let result: Awaited<ReturnType<typeof $>> | undefined

          if (lastExt === ".py") {
            result = await $`python ${lastFile}`.cwd(dir).quiet().nothrow()
          } else if (lastExt === ".js") {
            result = await $`node ${lastFile}`.cwd(dir).quiet().nothrow()
          } else if (lastExt === ".ts") {
            result = await $`npx tsx ${lastFile}`.cwd(dir).quiet().nothrow()
          } else if (lastExt === ".jsx" || lastExt === ".tsx") {
            const smokeFile = lastFile.replace(/\.(jsx|tsx)$/, `.smoke.${lastExt.slice(1)}`)
            if (existsSync(smokeFile)) {
              result = await $`npx tsx ${smokeFile}`.cwd(dir).quiet().nothrow()
            } else {
              toast(`[Rollabot] no smoke file for ${lastBase}`, "warning")
              smokeOutput = `\n⚠ NO SMOKE FILE [${lastBase}]: create ${path.basename(smokeFile)} to enable smoke.`
            }
          } else if (lastExt === ".rs") {
            result = await $`cargo test smoke`.cwd(directory).quiet().nothrow()
          } else if (lastExt === ".go") {
            result = await $`go test -run TestSmoke .`.cwd(dir).quiet().nothrow()
          } else if (lastExt === ".rb") {
            result = await $`ruby ${lastFile}`.cwd(dir).quiet().nothrow()
          }

          if (result !== undefined) {
            const out = ((result.stdout?.toString("utf8") ?? "") + (result.stderr?.toString("utf8") ?? "")).trim()
            if (result.exitCode === 0) {
              toast(`[Rollabot] smoke passed: ${lastBase} ✓`, "success")
              smokeFailedBySession.delete(input.sessionID)
              smokeOutput = `\n✓ SMOKE PASSED [${lastBase}] — safe to continue.`
            } else {
              toast(`[Rollabot] ⛔ smoke FAILED: ${lastBase}`, "error", 8000)
              smokeFailedBySession.set(input.sessionID, lastFile)
              smokeOutput = `\n✗ SMOKE FAILED [${lastBase}] — fix this file NOW. No other files until smoke passes.\n${out.slice(0, 500)}`
            }
          }
        } catch (e: any) {
          toast(`[Rollabot] smoke error: ${lastBase}`, "error")
          smokeFailedBySession.set(input.sessionID, lastFile)
          smokeOutput = `\n⚠ SMOKE ERROR [${lastBase}]: ${e?.message ?? String(e)}`
        }

        const SMOKE_HINT = `Smoke: py→python "f.py" | js→node "f.js" | ts→npx tsx "f.ts" | tsx→npx tsx "f.smoke.tsx" | rs→cargo test smoke | go→go test -run TestSmoke`
        output.output += smokeOutput + `\n${SMOKE_HINT}`
        return
      }

      // Other file written
      toast(`[Rollabot] file written: ${base}`, "info", 2000)
    },
  }
}
