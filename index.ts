import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import path from "path"

const agentBySession = new Map<string, string>()
const lastTextBySession = new Map<string, string>()
const lastCodeFileBySession = new Map<string, string>()
const smokeFailedBySession = new Map<string, string>()
const smokePendingBySession = new Set<string>() // code written, todo not updated yet
const designReadSentBySession = new Set<string>()
const firstCallSentBySession = new Set<string>()

type ToastVariant = "info" | "success" | "warning" | "error"

export const server: Plugin = async ({ directory, client }) => {
  // import.meta.dirname may be undefined in some runtimes — fall back to __dirname or CWD
  const pluginDir = (import.meta as any).dirname ?? __dirname ?? process.cwd()
  const reminderPath = path.join(pluginDir, "reminder.md")
  const designPath = path.join(directory, "design.md")

  // Load reminder once at startup — toast if missing so user knows immediately
  let reminderContent = ""
  try {
    reminderContent = readFileSync(reminderPath, "utf8").trim()
    if (!reminderContent) throw new Error("empty")
  } catch (e: any) {
    client.tui.showToast({ body: { message: `[Rollabot] ⚠ reminder.md not loaded: ${e?.message ?? e} (path: ${reminderPath})`, variant: "error", duration: 8000 }, query: { directory } }).catch(() => {})
  }

  const designExists = () => existsSync(designPath)
  const designEmpty = () => {
    try { return !readFileSync(designPath, "utf8").trim() } catch { return true }
  }
  const designMissing = () => !designExists() || designEmpty()

  const toast = (message: string, variant: ToastVariant = "info", duration = 4000) =>
    client.tui.showToast({ body: { message, variant, duration }, query: { directory } }).catch(() => {})

  // Resolve agent: prefer live input.agent (fires before chat.params in some hooks)
  const resolveAgent = (input: any) =>
    agentBySession.get(input.sessionID) ?? (input as any).agent ?? undefined

  return {
    // Track active agent per session + reset design-read reminder on agent switch
    "chat.params": async (input, _output) => {
      const prev = agentBySession.get(input.sessionID)
      if (prev !== input.agent) {
        agentBySession.set(input.sessionID, input.agent)
        designReadSentBySession.delete(input.sessionID)
        firstCallSentBySession.delete(input.sessionID)
        toast(`[Rollabot] agent: ${input.agent}`, "info", 2000)
      }
    },

    // Parse smoker result + buffer designer text
    "experimental.text.complete": async (input, output) => {
      const agent = resolveAgent(input)

      if (agent === "designer") {
        lastTextBySession.set(input.sessionID, output.text)
        return
      }

      if (agent === "smoker") {
        // Parse SMOKE:PASS / SMOKE:FAIL from last matching line
        const resultLine = output.text.trim().split("\n").reverse().find(l => l.startsWith("SMOKE:"))
        if (!resultLine) return
        const [, rest] = resultLine.split(/:PASS|:FAIL/)
        const filePart = (rest ?? "").split("—")[0].trim()
        const absFile = filePart ? (path.isAbsolute(filePart) ? filePart : path.join(directory, filePart)) : ""

        if (resultLine.startsWith("SMOKE:PASS")) {
          smokePendingBySession.delete(input.sessionID)
          smokeFailedBySession.delete(input.sessionID)
          toast(`[Rollabot] ✓ smoke passed: ${path.basename(filePart)}`, "success")
        } else if (resultLine.startsWith("SMOKE:FAIL")) {
          smokePendingBySession.delete(input.sessionID)
          if (absFile) smokeFailedBySession.set(input.sessionID, absFile)
          toast(`[Rollabot] ⛔ smoke FAILED: ${path.basename(filePart)}`, "error", 8000)
        }
      }
    },

    // Designer session idle: enforce design.md written — auto-save from output if missing
    "event": async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event as any).properties?.sessionID
      if (!sessionID || agentBySession.get(sessionID) !== "designer") return
      if (!designMissing()) return

      toast("[Rollabot] designer finished without writing design.md — auto-saving...", "warning")
      try {
        const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
        const messages: any[] = (res as any).data ?? []
        const assistantTexts = messages
          .filter((m: any) => m.role === "assistant")
          .flatMap((m: any) => (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text))
          .join("\n\n").trim()
        if (assistantTexts) {
          const { writeFileSync } = await import("fs")
          writeFileSync(designPath, `# Design (auto-saved from designer output)\n\n${assistantTexts}`)
          toast("[Rollabot] design.md auto-created from session messages ✓", "success")
          return
        }
      } catch {}

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

    // Inject rules + agent-specific enforcement at top of system prompt every call
    "experimental.chat.system.transform": async (input, output) => {
      const parts: string[] = []
      const agent = resolveAgent(input)

      if (reminderContent) parts.push(`RULES:\n${reminderContent}`)

      if (!firstCallSentBySession.has(input.sessionID)) {
        firstCallSentBySession.add(input.sessionID)
        parts.push(`If the user's request involves writing or modifying code, call @designer FIRST before doing anything else.`)
      }

      if (agent === "designer") {
        const missing = designMissing()
        if (missing) toast(`[Rollabot] designer active — design.md missing`, "warning")
        parts.push(
          `⚠ EVERY RESPONSE MUST write or append to "design.md" using Write or Edit tool.\n` +
          `design.md: ${missing ? "MISSING ✗ — CREATE it NOW" : "EXISTS ✓ — APPEND your plans NOW"}\n` +
          `NEVER use bash/heredoc. Not done until design.md has content.`
        )
      } else if (designMissing()) {
        toast(`[Rollabot] ⛔ design.md missing — VIOLATION`, "error", 6000)
        parts.push(
          `⛔⛔⛔ VIOLATION: design.md MISSING.\n` +
          `You CANNOT write code, files, or todos. You are failing your role.\n` +
          `STOP. Call @designer NOW to write design.md first.`
        )
      } else if (!designReadSentBySession.has(input.sessionID)) {
        // Only remind once per session
        designReadSentBySession.add(input.sessionID)
        parts.push(
          `📋 design.md exists. READ IT NOW before doing anything — a project may be in progress.`
        )
      }

      if (smokePendingBySession.has(input.sessionID)) {
        const pending = lastCodeFileBySession.get(input.sessionID)
        const rel = pending ? path.relative(directory, pending) : "last file"
        parts.push(`⚠ SMOKE PENDING: call @smoker with "${rel}" NOW. No new code files until SMOKE:PASS.`)
      }

      const smokeFail = smokeFailedBySession.get(input.sessionID)
      if (smokeFail) {
        parts.push(`⛔ SMOKE FAILING: "${path.basename(smokeFail)}" — fix it before any other file.`)
      }

      if (parts.length > 0) {
        const injection = parts.join("\n\n")
        if (!Array.isArray(output.system) || output.system.length === 0) {
          ;(output.system as string[]) = [injection]
        } else {
          output.system[0] = injection + "\n\n" + output.system[0]
        }
      }
    },

    // Gate writes behind design.md + smoke state
    "tool.execute.before": async (input, output) => {
      if (!["write", "edit"].includes(input.tool.toLowerCase())) return

      // FIX: try input.args first (correct), fall back to output.args (mutable copy)
      const args = (input as any).args ?? output.args
      const filePath: string = args?.filePath || args?.file_path || args?.path
      if (!filePath) return

      const agent = resolveAgent(input)
      const base = path.basename(filePath).toLowerCase()
      const isDesignFile = base === "design.md"

      // Block all writes while smoke is failing (except the failing file itself)
      const smokeFail = smokeFailedBySession.get(input.sessionID)
      if (smokeFail && path.resolve(filePath) !== path.resolve(smokeFail)) {
        toast(`[Rollabot] ⛔ blocked — fix smoke in ${path.basename(smokeFail)} first`, "error")
        throw new Error(`Smoke FAILING in "${smokeFail}". Fix it before writing anything else.`)
      }

      // Block next code file while smoke test is still pending (todo not updated yet)
      const ext2 = path.extname(filePath).toLowerCase()
      const CODE_EXTS2 = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb"]
      const isDesignFile2 = path.basename(filePath).toLowerCase() === "design.md"
      if (smokePendingBySession.has(input.sessionID) && CODE_EXTS2.includes(ext2) && !isDesignFile2) {
        const pending = lastCodeFileBySession.get(input.sessionID)
        toast(`[Rollabot] ⛔ update todos first — smoke pending for ${pending ? path.basename(pending) : "last file"}`, "error")
        throw new Error(`Update todos first to run smoke test for "${pending ?? "last file"}". No new code files until smoke clears.`)
      }

      const ext = path.extname(filePath).toLowerCase()
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb"]
      const isTodo = base.includes("todo") || base.includes("task") || base.includes("checklist")

      if (agent === "designer" && isDesignFile) return

      if (agent === "designer" && !isDesignFile) {
        toast(`[Rollabot] ⛔ designer blocked — can only write design.md`, "error")
        throw new Error(`Designer can ONLY write design.md. You tried to write "${base}". Write your plans to design.md instead.`)
      }

      if (isTodo && designMissing()) {
        toast(`[Rollabot] ⛔ todo blocked — design.md missing`, "error")
        throw new Error(`design.md missing. Call @designer first.`)
      }

      // FIX: was agent === "build" — now applies to all non-designer agents
      if (agent !== "designer" && CODE_EXTS.includes(ext) && designMissing()) {
        toast(`[Rollabot] ⛔ code write blocked — design.md missing`, "error")
        throw new Error(`design.md missing. Call @designer first before writing code.`)
      }
    },

    // After writes: verify design.md for designer; record code files; smoke on todo update
    "tool.execute.after": async (input, output) => {
      if (!["write", "edit"].includes(input.tool.toLowerCase())) return

      const filePath: string = input.args?.filePath || input.args?.file_path || input.args?.path
      if (!filePath) return

      const agent = resolveAgent(input)
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(directory, filePath)
      const ext = path.extname(filePath).toLowerCase()
      const base = path.basename(filePath)
      const isDesignFile = base.toLowerCase() === "design.md"
      const isTodo = base.toLowerCase().includes("todo") || base.toLowerCase().includes("task")
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb"]
      const isTypeOnly = base.endsWith(".d.ts")

      output.output ??= ""

      // Designer wrote — check design.md
      if (agent === "designer") {
        if (isDesignFile) {
          if (designMissing()) {
            toast(`[Rollabot] ⛔ design.md written but empty`, "error")
            output.output += `\n\n⛔ design.md is empty. Write your plans into it now.`
          } else {
            toast(`[Rollabot] design.md written ✓`, "success")
            output.output += `\n\n✓ design.md written.`
          }
        } else if (designMissing()) {
          toast(`[Rollabot] ⛔ design.md still missing after write`, "error")
          output.output += `\n\n⛔ design.md still MISSING. Write it now.`
        }
        return
      }

      // Code file written — record for smoke on next todo update (skip .d.ts)
      if (CODE_EXTS.includes(ext) && !isTypeOnly) {
        lastCodeFileBySession.set(input.sessionID, absPath)
        smokePendingBySession.add(input.sessionID)
        toast(`[Rollabot] ${base} written — smoke pending`, "warning", 3000)
        output.output += `\n⚠ SMOKE PENDING: update todos NOW to run smoke for "${base}". Cannot write another code file until smoke clears.`
        return
      }

      // Todo updated — trigger smoker agent
      if (isTodo) {
        const lastFile = lastCodeFileBySession.get(input.sessionID)
        if (!lastFile) {
          toast(`[Rollabot] todo updated`, "info", 2000)
          return
        }
        const rel = path.relative(directory, lastFile)
        toast(`[Rollabot] todo updated — call @smoker for ${path.basename(lastFile)}`, "info", 2000)
        output.output += `\n⚠ MANDATORY: call @smoker with path "${rel}". Do NOT write any more code until you see SMOKE:PASS.`
        return
      }

      // Other file written
      toast(`[Rollabot] file written: ${base}`, "info", 2000)
    },
  }
}
