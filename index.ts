import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import path from "path"

const agentBySession = new Map<string, string>()
const lastTextBySession = new Map<string, string>() // fallback buffer: last LLM text per session

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
          `Use the Write tool (create) or Edit tool (append). You are NOT done until design.md has content.\n` +
          `Do NOT respond with text only — always end by writing/appending to design.md.`
        )
      } else if (designMissing()) {
        toast(`[Rollabot] design.md missing — blocking ${agent ?? "agent"}`, "warning")
        parts.push(
          `⛔ design.md is MISSING or EMPTY ("${designPath}").\n` +
          `Call @designer first. Do NOT write code or todos until design.md exists.`
        )
      }

      if (parts.length > 0) {
        output.system[0] = (output.system[0] ?? "") + "\n" + parts.join("\n")
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

    // After writes: verify design.md for designer, smoke test for code files
    "tool.execute.after": async (input, output) => {
      if (!["write", "edit"].includes(input.tool.toLowerCase())) return

      const filePath: string = input.args?.filePath || input.args?.file_path || input.args?.path
      if (!filePath) return

      const agent = agentBySession.get(input.sessionID)
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(directory, filePath)
      const ext = path.extname(filePath).toLowerCase()
      const dir = path.dirname(absPath)
      const base = path.basename(filePath)
      const isDesignFile = base.toLowerCase() === "design.md"
      const isTodo = base.toLowerCase().includes("todo") || base.toLowerCase().includes("task")

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

      // Todo file created or updated
      if (isTodo) {
        const existed = existsSync(absPath)
        toast(`[Rollabot] todo ${existed ? "updated" : "created"}: ${base}`, "info")
        output.output += `\n📋 todo ${existed ? "updated" : "created"}.`
        return
      }

      // Code file — run smoke test
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb"]
      if (!CODE_EXTS.includes(ext)) {
        toast(`[Rollabot] file written: ${base}`, "info", 2000)
        output.output += `\n📋 Update todos — mark "${base}" done.`
        return
      }

      toast(`[Rollabot] running smoke test: ${base}`, "info", 2000)

      let smokeOutput = ""
      try {
        let result: Awaited<ReturnType<typeof $>> | undefined

        if (ext === ".py") {
          result = await $`python ${absPath}`.cwd(dir).quiet().nothrow()
        } else if (ext === ".js") {
          result = await $`node ${absPath}`.cwd(dir).quiet().nothrow()
        } else if (ext === ".ts") {
          result = await $`npx tsx ${absPath}`.cwd(dir).quiet().nothrow()
        } else if (ext === ".jsx" || ext === ".tsx") {
          const smokeFile = absPath.replace(/\.(jsx|tsx)$/, `.smoke.${ext.slice(1)}`)
          if (existsSync(smokeFile)) {
            result = await $`npx tsx ${smokeFile}`.cwd(dir).quiet().nothrow()
          } else {
            toast(`[Rollabot] no smoke file for ${base}`, "warning")
            smokeOutput = `\n⚠ NO SMOKE FILE [${base}]: create ${path.basename(smokeFile)}.`
          }
        } else if (ext === ".rs") {
          result = await $`cargo test smoke`.cwd(directory).quiet().nothrow()
        } else if (ext === ".go") {
          result = await $`go test -run TestSmoke .`.cwd(dir).quiet().nothrow()
        } else if (ext === ".rb") {
          result = await $`ruby ${absPath}`.cwd(dir).quiet().nothrow()
        }

        if (result !== undefined) {
          const out = ((result.stdout?.toString("utf8") ?? "") + (result.stderr?.toString("utf8") ?? "")).trim()
          if (result.exitCode === 0) {
            toast(`[Rollabot] smoke passed: ${base}`, "success")
            smokeOutput = `\n✓ SMOKE PASSED [${base}]`
          } else {
            toast(`[Rollabot] smoke FAILED: ${base}`, "error", 6000)
            smokeOutput = `\n✗ SMOKE FAILED [${base}] — fix before next file:\n${out.slice(0, 500)}`
          }
        }
      } catch (e: any) {
        toast(`[Rollabot] smoke error: ${base}`, "error")
        smokeOutput = `\n⚠ SMOKE ERROR [${base}]: ${e?.message ?? String(e)}`
      }

      const SMOKE_HINT = `Smoke: py→python "f.py" | js→node "f.js" | ts→npx tsx "f.ts" | tsx→npx tsx "f.smoke.tsx" | rs→cargo test smoke | go→go test -run TestSmoke`
      output.output += smokeOutput + `\n📋 Update todos — mark "${base}" done.\n${SMOKE_HINT}`
    },
  }
}
