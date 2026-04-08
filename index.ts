import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "fs"
import path from "path"

const agentBySession = new Map<string, string>()
const lastTextBySession = new Map<string, string>()
const lastCodeFileBySession = new Map<string, string>()
const smokeFailedBySession = new Map<string, string>()
const smokePendingBySession = new Set<string>()
const designReadSentBySession = new Set<string>()
const cavemodeBySession = new Set<string>()
const pipelineEnabledBySession = new Set<string>()  // OFF by default — /design enables it
const designerCallNeededBySession = new Set<string>()
const designClarifyingBySession = new Set<string>()       // waiting for user to answer clarifying Qs
const designQuestionsAskedBySession = new Set<string>()   // AI has asked Qs, next user msg triggers designer
const designInitialPromptBySession = new Map<string, string>()
const pendingInjBySession = new Map<string, string>()

type ToastVariant = "info" | "success" | "warning" | "error"

export const server: Plugin = async ({ directory, client }) => {
  const pluginDir = (import.meta as any).dirname ?? __dirname ?? process.cwd()
  const reminderPath = path.join(pluginDir, "reminder.md")
  const designPath = path.join(directory, "design.md")

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

  const resolveAgent = (input: any) =>
    agentBySession.get(input.sessionID) ?? (input as any).agent ?? undefined

  return {
    // Detect toggle commands + track agent switches
    "chat.message": async (input, output) => {
      const sessionID = input.sessionID
      const agent = input.agent ?? "default"

      // Track agent switches
      const prev = agentBySession.get(sessionID)
      if (prev !== agent) {
        agentBySession.set(sessionID, agent)
        designReadSentBySession.delete(sessionID)
        const agentLabel: Record<string, string> = {
          designer: "Designer invoked",
          smoker: "Smoker invoked",
          coder: "Coder invoked",
          plan: "Plan agent invoked",
        }
        toast(`[Rollabot] ${agentLabel[agent] ?? `Agent: ${agent}`}`, "info", 2500)
      }

      // Read text from message parts
      const textPart = (output.parts ?? []).find((p: any) => p.type === "text") as any
      let text: string = textPart?.text ?? ""

      if (text.includes("ROLLABOT_CM_TOGGLE")) {
        if (cavemodeBySession.has(sessionID)) {
          cavemodeBySession.delete(sessionID)
          toast("[Rollabot] cavemode OFF", "info", 2000)
        } else {
          cavemodeBySession.add(sessionID)
          toast("[Rollabot] cavemode ON", "success", 2000)
        }
        text = text.replace(/ROLLABOT_CM_TOGGLE\s*/g, "").trim()
        textPart.text = text
      }

      if (text.includes("ROLLABOT_DESIGN_TOGGLE")) {
        if (pipelineEnabledBySession.has(sessionID)) {
          pipelineEnabledBySession.delete(sessionID)
          designerCallNeededBySession.delete(sessionID)
          designClarifyingBySession.delete(sessionID)
          designQuestionsAskedBySession.delete(sessionID)
          designInitialPromptBySession.delete(sessionID)
          toast("[Rollabot] design+smoke pipeline OFF", "warning", 3000)
        } else {
          const prompt = text.replace(/ROLLABOT_DESIGN_TOGGLE\s*/g, "").trim()
          pipelineEnabledBySession.add(sessionID)
          if (designMissing()) {
            designClarifyingBySession.add(sessionID)
            if (prompt) designInitialPromptBySession.set(sessionID, prompt)
            toast("[Rollabot] /design — clarification phase started", "success", 3000)
          } else {
            toast("[Rollabot] /design — design.md exists, skipping to implementation", "success", 3000)
          }
        }
        text = text.replace(/ROLLABOT_DESIGN_TOGGLE\s*/g, "").trim()
        textPart.text = text
      }

      if (text.includes("ROLLABOT_SMART")) {
        const userCommand = text.replace(/ROLLABOT_SMART\s*/g, "").trim()
        text = `Before doing this task, think step by step about how you would approach it — write out your plan visibly so I can follow along. Then execute it fully.\n\nTask: ${userCommand}`
        textPart.text = text
        toast("[Rollabot] /smart — thinking mode active", "info", 2500)
      }

      // Clarification phase: user has answered → move to designer
      if (designClarifyingBySession.has(sessionID) && designQuestionsAskedBySession.has(sessionID)) {
        designQuestionsAskedBySession.delete(sessionID)
        designClarifyingBySession.delete(sessionID)
        designerCallNeededBySession.add(sessionID)
        toast("[Rollabot] requirements gathered — calling @designer", "success", 3000)
      }

      const injParts: string[] = []

      if (reminderContent) injParts.push(`RULES:\n${reminderContent}`)

      if (cavemodeBySession.has(sessionID)) {
        injParts.push(
          `CAVEMODE ON: strip articles(the/a/an), filler(I will/let me/I'll/great/now I/happy to/I am going to/I need to), narration, preamble.\n` +
          `Every word must carry info — zero decoration. No restating what was asked.\n` +
          `Apply same density to your internal reasoning: keep step count, cut all fluff per step.\n` +
          `Bad: "I will now fix the bug on the second line of the file"\n` +
          `Good: "fix bug line 2"`
        )
      }

      const pipelineOn = pipelineEnabledBySession.has(sessionID)

      if (!pipelineOn) {
        injParts.push(`⚙ design+smoke pipeline INACTIVE. Use /design <prompt> to enable full pipeline. Smoke testing code is still MANDATORY regardless.`)
      } else if (designClarifyingBySession.has(sessionID)) {
        const initialPrompt = designInitialPromptBySession.get(sessionID) ?? "(no prompt given)"
        injParts.push(
          `🔍 CLARIFICATION PHASE — DO NOT call @designer yet.\n` +
          `User's initial request: "${initialPrompt}"\n` +
          `Your job now: use the "question" tool to ask ALL clarifying questions in a SINGLE tool call.\n` +
          `Pass a "questions" array covering every unknown: goals & scope, must-have features, nice-to-haves, ` +
          `tech stack preferences, UI/UX style, target users, performance/scale needs, integrations, constraints, anything ambiguous.\n` +
          `Be thorough — missing a requirement now means rework later.\n` +
          `After the user answers, @designer will be called automatically with the full brief.\n` +
          `IMPORTANT: use the "question" tool — do NOT write questions as plain text.`
        )
      } else {
        injParts.push(
          `PIPELINE: ask until clear → @designer (writes design.md) → implement steps from design.md (split frontend/backend).\n` +
          `CODE: write file → update todo → smoke test runs automatically. No next file until smoke passes.\n` +
          `DESIGN.MD: always follow design.md. If you have not read it yet this session, use the Read tool on design.md BEFORE any Write or Edit call.\n` +
          `DESIGN.MD CHANGES: if any planned change conflicts with design.md OR is not covered by it (even small relevant ones), you MUST update design.md FIRST before applying the change. No exceptions.\n` +
          `⚠ CRITICAL: ONLY the @designer subagent can create or write design.md. YOU MUST NEVER create or write design.md yourself. If design.md is missing, invoke the Task tool with agent="designer" and the full specs as the prompt — that is how you call @designer. Do NOT write design.md yourself.`
        )
        if (designerCallNeededBySession.has(sessionID)) {
          designerCallNeededBySession.delete(sessionID)
          injParts.push(`🎨 Call @designer NOW: use the Task tool with agent="designer" and the full specs as the prompt. @designer will write design.md.`)
        }

        if (agent === "designer") {
          const missing = designMissing()
          if (missing) toast(`[Rollabot] designer active — design.md missing`, "warning")
          injParts.push(
            `⚠ YOU MUST write or append to "design.md" using Write or Edit tool.\n` +
            `design.md: ${missing ? "MISSING ✗ — CREATE it NOW" : "EXISTS ✓ — APPEND your plans NOW"}\n` +
            `NEVER use bash/heredoc. Not done until design.md has content.`
          )
        } else if (designMissing()) {
          toast(`[Rollabot] ⛔ design.md missing — VIOLATION`, "error", 6000)
          injParts.push(
            `⛔⛔⛔ VIOLATION: design.md MISSING.\n` +
            `You CANNOT write code, files, or todos. You are failing your role.\n` +
            `STOP. Use the Task tool with agent="designer" and full specs as prompt. Do NOT write design.md yourself.`
          )
        } else if (!designReadSentBySession.has(sessionID)) {
          designReadSentBySession.add(sessionID)
          injParts.push(`📋 design.md exists. READ IT NOW before doing anything — a project may be in progress.`)
        }


        const smokeFail = smokeFailedBySession.get(sessionID)
        if (smokeFail) injParts.push(`⛔ SMOKE FAILING: "${path.basename(smokeFail)}" — fix it before any other file.`)
      }

      // Store injection for transform hook (applied to LLM payload only, not stored/displayed)
      if (injParts.length > 0) {
        pendingInjBySession.set(sessionID, injParts.join("\n\n"))
      }
    },

    // Inject into last user msg + strip from older ones — LLM payload only, TUI never sees it
    "experimental.chat.messages.transform": async (input, output) => {
      const msgs: any[] = output.messages ?? (input as any).messages
      if (!msgs || msgs.length === 0) return

      let lastUserIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info?.role === "user") { lastUserIdx = i; break }
      }
      if (lastUserIdx === -1) return

      const sessionID: string = msgs[lastUserIdx].info?.sessionID
      const injection = sessionID ? pendingInjBySession.get(sessionID) : undefined

      const MARKER = "\n\n---\n"

      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].info?.role !== "user") continue
        const textPart = (msgs[i].parts ?? []).find((p: any) => p.type === "text") as any
        if (!textPart) continue

        if (i === lastUserIdx) {
          // Append injection to last user message for this API call only
          if (injection) textPart.text = (textPart.text ?? "").trimEnd() + MARKER + injection
        } else {
          // Strip any previously injected content from older messages
          if (typeof textPart.text === "string" && textPart.text.includes(MARKER)) {
            textPart.text = textPart.text.slice(0, textPart.text.indexOf(MARKER))
          }
        }
      }
    },

    // Parse smoker result + buffer designer text
    "experimental.text.complete": async (input, output) => {
      const agent = resolveAgent(input)

      // Mark that AI has responded during clarification phase — next user msg triggers designer
      if (designClarifyingBySession.has(input.sessionID) && agent !== "designer") {
        designQuestionsAskedBySession.add(input.sessionID)
      }

      if (agent === "designer") {
        lastTextBySession.set(input.sessionID, output.text)
        return
      }

      if (agent === "smoker") {
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

    // Designer session idle: enforce design.md written
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

    // Gate writes behind design.md + smoke state
    "tool.execute.before": async (input, output) => {
      if (!pipelineEnabledBySession.has(input.sessionID)) return
      if (!["write", "edit"].includes(input.tool.toLowerCase())) return

      const args = (input as any).args ?? output.args
      const filePath: string = args?.filePath || args?.file_path || args?.path
      if (!filePath) return

      const agent = resolveAgent(input)
      const base = path.basename(filePath).toLowerCase()
      const isDesignFile = base === "design.md"

      const smokeFail = smokeFailedBySession.get(input.sessionID)
      if (smokeFail && path.resolve(filePath) !== path.resolve(smokeFail)) {
        toast(`[Rollabot] ⛔ blocked — fix smoke in ${path.basename(smokeFail)} first`, "error")
        throw new Error(`Smoke FAILING in "${smokeFail}". Fix it before writing anything else.`)
      }


      if (agent === "designer" && isDesignFile) {
        // If design.md already exists, append instead of overwrite
        if (!designMissing() && input.tool.toLowerCase() === "write") {
          const existing = readFileSync(designPath, "utf8").trimEnd()
          const newContent: string = output.args?.content ?? output.args?.text ?? (input as any).args?.content ?? ""
          if (newContent) {
            output.args = { ...(output.args ?? {}), content: `${existing}\n\n${newContent}` }
            toast("[Rollabot] designer — appending to existing design.md", "info", 2500)
          }
        }
        return
      }

      if (agent === "designer" && !isDesignFile) {
        toast(`[Rollabot] ⛔ designer blocked — can only write design.md`, "error")
        throw new Error(`Designer can ONLY write design.md. You tried to write "${base}". Write your plans to design.md instead.`)
      }

      const ext = path.extname(filePath).toLowerCase()
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb", ".html", ".css", ".sql"]
      const isTodo = base.includes("todo") || base.includes("task") || base.includes("checklist")

      if (isTodo && designMissing()) {
        toast(`[Rollabot] ⛔ todo blocked — design.md missing`, "error")
        throw new Error(`design.md missing. Call @designer first.`)
      }

      if (agent !== "designer" && CODE_EXTS.includes(ext) && designMissing()) {
        toast(`[Rollabot] ⛔ write blocked — design.md missing`, "error")
        throw new Error(`design.md missing. Call @designer first before writing code.`)
      }
    },

    // Verbose toast for every tool action + pipeline enforcement
    "tool.execute.after": async (input, output) => {
      const tool = input.tool.toLowerCase()
      const args: any = input.args ?? {}

      if (tool === "write") {
        const f = args.filePath ?? args.file_path ?? args.path ?? "?"
        toast(`[Rollabot] File written: ${path.basename(f)}`, "success", 2500)
      } else if (tool === "edit") {
        const f = args.filePath ?? args.file_path ?? args.path ?? "?"
        toast(`[Rollabot] File edited: ${path.basename(f)}`, "info", 2500)
      } else if (tool === "read") {
        const f = args.filePath ?? args.file_path ?? args.path ?? "?"
        toast(`[Rollabot] Read: ${path.basename(f)}`, "info", 1500)
      } else if (tool === "bash") {
        const cmd = String(args.command ?? args.cmd ?? "").slice(0, 60)
        toast(`[Rollabot] Bash: ${cmd}${cmd.length === 60 ? "..." : ""}`, "info", 2000)
      } else if (tool === "glob") {
        toast(`[Rollabot] Glob: ${args.pattern ?? "?"}`, "info", 1500)
      } else if (tool === "grep") {
        toast(`[Rollabot] Grep: ${args.pattern ?? "?"}`, "info", 1500)
      } else if (tool === "webfetch") {
        const url = String(args.url ?? args.URL ?? "").slice(0, 70)
        toast(`[Rollabot] Fetch: ${url}`, "info", 2000)
      } else if (tool === "websearch") {
        const q = String(args.query ?? args.q ?? "").slice(0, 60)
        toast(`[Rollabot] Search: ${q}`, "info", 2000)
      } else if (tool === "task") {
        const desc = String(args.description ?? args.prompt ?? "").slice(0, 60)
        toast(`[Rollabot] Subtask: ${desc}`, "info", 2000)
      }

      if (!pipelineEnabledBySession.has(input.sessionID)) return
      if (!["write", "edit"].includes(tool)) return

      const filePath: string = args.filePath ?? args.file_path ?? args.path
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

      if (agent === "designer") {
        if (isDesignFile) {
          if (designMissing()) {
            toast(`[Rollabot] design.md empty after write`, "error")
            output.output += `\n\n⛔ design.md is empty. Write your plans into it now.`
          } else {
            toast(`[Rollabot] design.md written ✓`, "success")
            output.output += `\n\n✓ design.md written.`
          }
        } else if (designMissing()) {
          toast(`[Rollabot] design.md still missing`, "error")
          output.output += `\n\n⛔ design.md still MISSING. Write it now.`
        }
        return
      }

      if (CODE_EXTS.includes(ext) && !isTypeOnly) {
        lastCodeFileBySession.set(input.sessionID, absPath)
        smokePendingBySession.add(input.sessionID)
        toast(`[Rollabot] Smoke pending: ${base}`, "warning", 3000)
        output.output += `\n⚠ SMOKE PENDING: update todos NOW to run smoke for "${base}". Cannot write another code file until smoke clears.`
        return
      }

      if (isTodo) {
        const lastFile = lastCodeFileBySession.get(input.sessionID)
        if (!lastFile) {
          toast(`[Rollabot] Todo updated`, "info", 2000)
          return
        }
        const rel = path.relative(directory, lastFile)
        toast(`[Rollabot] Todo updated — smoker needed: ${path.basename(lastFile)}`, "warning", 3000)
        output.output += `\n⚠ MANDATORY: call @smoker with path "${rel}". Do NOT write any more code until you see SMOKE:PASS.`
        return
      }

      toast(`[Rollabot] File written: ${base}`, "info", 2000)
    },
  }
}
