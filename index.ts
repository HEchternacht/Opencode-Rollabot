import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "fs"
import path from "path"

const agentBySession = new Map<string, string>()
const lastCodeFileBySession = new Map<string, string>()
const smokeFailedBySession = new Map<string, string>()
const smokePendingBySession = new Set<string>()
const designReadSentBySession = new Set<string>()
const cavemodeBySession = new Set<string>()
const pipelineEnabledBySession = new Set<string>()
const pendingInjBySession = new Map<string, string>()

type ToastVariant = "info" | "success" | "warning" | "error"

export const server: Plugin = async ({ directory, client }) => {
  const pluginDir = (import.meta as any).dirname ?? __dirname ?? process.cwd()
  const reminderPath = path.join(pluginDir, "reminder.md")

  let reminderContent = ""
  try {
    reminderContent = readFileSync(reminderPath, "utf8").trim()
    if (!reminderContent) throw new Error("empty")
  } catch (e: any) {
    client.tui.showToast({ body: { message: `[Rollabot] ⚠ reminder.md not loaded: ${e?.message ?? e} (path: ${reminderPath})`, variant: "error", duration: 8000 }, query: { directory } }).catch(() => {})
  }

  const getDesignPath = (dir: string) => path.join(dir, "design.md")
  const designExists = (dir: string) => existsSync(getDesignPath(dir))
  const designEmpty = (dir: string) => {
    try { return !readFileSync(getDesignPath(dir), "utf8").trim() } catch { return true }
  }
  const designMissing = (dir: string) => !designExists(dir) || designEmpty(dir)

  const toast = (message: string, variant: ToastVariant = "info", duration = 4000) =>
    client.tui.showToast({ body: { message, variant, duration }, query: { directory } }).catch(() => {})

  const resolveAgent = (input: any) =>
    agentBySession.get(input.sessionID) ?? (input as any).agent ?? undefined

  return {
    tool: {
      create_design: tool({
        description: "Create the project design document (design.md) and todo list (todo.md) from structured specs. This is the ONLY way to create design.md. Call ONCE after gathering all requirements from the user.",
        args: {
          goal: tool.schema.string().describe("What we're building — 1-2 sentences"),
          stack: tool.schema.string().describe("Tech stack (e.g. 'React + FastAPI + PostgreSQL')"),
          features: tool.schema.array(tool.schema.string()).describe("Feature list"),
          structure: tool.schema.string().describe("Project folder structure / architecture overview"),
          steps: tool.schema.array(tool.schema.string()).describe("Implementation steps in order — each becomes a TODO item"),
          notes: tool.schema.string().optional().describe("Extra constraints, decisions, or non-obvious details"),
        },
        execute: async (args, context) => {
          const dp = path.join(context.directory, "design.md")
          const tp = path.join(context.directory, "todo.md")

          const featureList = args.features.map(f => `- ${f}`).join("\n")
          const stepsList = args.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
          const todoItems = args.steps.map(s => `- [ ] ${s}`).join("\n")

          const designContent = [
            `# Goal\n${args.goal}`,
            `## Stack\n${args.stack}`,
            `## Features\n${featureList}`,
            `## Structure\n\`\`\`\n${args.structure}\n\`\`\``,
            `## Implementation Steps\n${stepsList}`,
            ...(args.notes ? [`## Notes\n${args.notes}`] : []),
          ].join("\n\n") + "\n"

          const todoContent = `# TODO\n\n${todoItems}\n`

          writeFileSync(dp, designContent)
          writeFileSync(tp, todoContent)
          pipelineEnabledBySession.add(context.sessionID)

          toast("[Rollabot] design.md + todo.md created ✓", "success", 3000)
          return `✓ design.md and todo.md written.\n\n--- design.md ---\n${designContent}\n--- todo.md ---\n${todoContent}`
        },
      }),
    },

    "chat.message": async (input, output) => {
      const sessionID = input.sessionID
      const agent = input.agent ?? "default"

      // Track agent switches
      const prev = agentBySession.get(sessionID)
      if (prev !== agent) {
        agentBySession.set(sessionID, agent)
        designReadSentBySession.delete(sessionID)
        const agentLabel: Record<string, string> = {
          smoker: "Smoker invoked",
          coder: "Coder invoked",
          plan: "Plan agent invoked",
        }
        if (agentLabel[agent]) toast(`[Rollabot] ${agentLabel[agent]}`, "info", 2500)
      }

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
          designReadSentBySession.delete(sessionID)
          toast("[Rollabot] design+smoke pipeline OFF", "warning", 3000)
        } else {
          pipelineEnabledBySession.add(sessionID)
          toast("[Rollabot] design+smoke pipeline ON", "success", 3000)
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
        injParts.push(`⚙ design+smoke pipeline INACTIVE. Use /design to enable. Smoke testing code is MANDATORY regardless.`)
      } else {
        const missing = designMissing(directory)

        if (missing) {
          injParts.push(
            `PIPELINE ACTIVE.\n` +
            `CODE: write file → update todo → smoke test runs automatically. No next file until smoke passes.\n` +
            `⚠ design.md MISSING — ask the user any clarifying questions, then call the create_design tool with: goal, stack, features, structure, steps, notes. Do NOT write code until design.md exists.`
          )
        } else {
          const alreadyRead = designReadSentBySession.has(sessionID)
          if (!alreadyRead) designReadSentBySession.add(sessionID)
          injParts.push(
            `PIPELINE ACTIVE.\n` +
            `CODE: write file → update todo → smoke test runs automatically. No next file until smoke passes.\n` +
            `DESIGN.MD: ${alreadyRead ? "follow it" : "READ IT NOW before doing anything — read design.md first"}.\n` +
            `DESIGN.MD CHANGES: if any planned change conflicts with design.md OR is not covered, edit design.md FIRST. No exceptions.`
          )
        }

        const smokeFail = smokeFailedBySession.get(sessionID)
        if (smokeFail) injParts.push(`⛔ SMOKE FAILING: "${path.basename(smokeFail)}" — fix it before any other file.`)
      }

      if (injParts.length > 0) {
        pendingInjBySession.set(sessionID, injParts.join("\n\n"))
      }
    },

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
          if (injection) textPart.text = (textPart.text ?? "").trimEnd() + MARKER + injection
        } else {
          if (typeof textPart.text === "string" && textPart.text.includes(MARKER)) {
            textPart.text = textPart.text.slice(0, textPart.text.indexOf(MARKER))
          }
        }
      }
    },

    "experimental.text.complete": async (input, output) => {
      const agent = resolveAgent(input)
      if (agent !== "smoker") return

      const resultLine = output.text.trim().split("\n").reverse().find((l: string) => l.startsWith("SMOKE:"))
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
    },

    "tool.execute.before": async (input, output) => {
      if (!pipelineEnabledBySession.has(input.sessionID)) return
      if (!["write", "edit"].includes(input.tool.toLowerCase())) return

      const args = (input as any).args ?? output.args
      const filePath: string = args?.filePath || args?.file_path || args?.path
      if (!filePath) return

      const smokeFail = smokeFailedBySession.get(input.sessionID)
      if (smokeFail && path.resolve(filePath) !== path.resolve(smokeFail)) {
        toast(`[Rollabot] ⛔ blocked — fix smoke in ${path.basename(smokeFail)} first`, "error")
        throw new Error(`Smoke FAILING in "${smokeFail}". Fix it before writing anything else.`)
      }

      const ext = path.extname(filePath).toLowerCase()
      const base = path.basename(filePath).toLowerCase()
      const isTodo = base.includes("todo") || base.includes("task") || base.includes("checklist")
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb", ".html", ".css", ".sql"]

      if ((isTodo || CODE_EXTS.includes(ext)) && designMissing(directory)) {
        toast(`[Rollabot] ⛔ write blocked — design.md missing`, "error")
        throw new Error(`design.md missing. Call the create_design tool first.`)
      }
    },

    "tool.execute.after": async (input, output) => {
      const tool_name = input.tool.toLowerCase()
      const args: any = input.args ?? {}

      if (tool_name === "write") {
        const f = args.filePath ?? args.file_path ?? args.path ?? "?"
        toast(`[Rollabot] File written: ${path.basename(f)}`, "success", 2500)
      } else if (tool_name === "edit") {
        const f = args.filePath ?? args.file_path ?? args.path ?? "?"
        toast(`[Rollabot] File edited: ${path.basename(f)}`, "info", 2500)
      } else if (tool_name === "read") {
        const f = args.filePath ?? args.file_path ?? args.path ?? "?"
        toast(`[Rollabot] Read: ${path.basename(f)}`, "info", 1500)
      } else if (tool_name === "bash") {
        const cmd = String(args.command ?? args.cmd ?? "").slice(0, 60)
        toast(`[Rollabot] Bash: ${cmd}${cmd.length === 60 ? "..." : ""}`, "info", 2000)
      } else if (tool_name === "glob") {
        toast(`[Rollabot] Glob: ${args.pattern ?? "?"}`, "info", 1500)
      } else if (tool_name === "grep") {
        toast(`[Rollabot] Grep: ${args.pattern ?? "?"}`, "info", 1500)
      } else if (tool_name === "webfetch") {
        const url = String(args.url ?? args.URL ?? "").slice(0, 70)
        toast(`[Rollabot] Fetch: ${url}`, "info", 2000)
      } else if (tool_name === "websearch") {
        const q = String(args.query ?? args.q ?? "").slice(0, 60)
        toast(`[Rollabot] Search: ${q}`, "info", 2000)
      } else if (tool_name === "task") {
        const desc = String(args.description ?? args.prompt ?? "").slice(0, 60)
        toast(`[Rollabot] Subtask: ${desc}`, "info", 2000)
      }

      if (!pipelineEnabledBySession.has(input.sessionID)) return
      if (!["write", "edit"].includes(tool_name)) return

      const filePath: string = args.filePath ?? args.file_path ?? args.path
      if (!filePath) return

      const absPath = path.isAbsolute(filePath) ? filePath : path.join(directory, filePath)
      const ext = path.extname(filePath).toLowerCase()
      const base = path.basename(filePath)
      const isTodo = base.toLowerCase().includes("todo") || base.toLowerCase().includes("task")
      const CODE_EXTS = [".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".rb"]
      const isTypeOnly = base.endsWith(".d.ts")

      output.output ??= ""

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
