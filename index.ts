import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendGuardLog, cleanupOrphanedHeadlessChrome, resolveLogPath } from "./src/cleanup.ts";
import {
  extractChromeTargets,
  isScriptFilePath,
  sanitizeScriptText,
  sanitizeShellChromeCommand,
  WINDOWS_CHROME_SYSTEM_HINT,
} from "./src/guard.ts";

/**
 * pi-vision-guard: keeps local LLM browser/vision runs fast and clean on Windows.
 */
export default function piVisionGuardExtension(pi: ExtensionAPI): void {
  const trackedPorts = new Set<string>();
  const trackedDirs = new Set<string>();
  const logPath = resolveLogPath();
  let currentCwd = process.cwd();
  let rewriteCount = 0;
  let sweptCount = 0;
  let warnedVisionInput = false;

  function recordTargets(text: string): void {
    const { ports, dirs } = extractChromeTargets(text);
    for (const p of ports) trackedPorts.add(p);
    for (const d of dirs) trackedDirs.add(d);
  }

  function warnIfLocalModelLacksImageInput(ctx: ExtensionContext): void {
    if (warnedVisionInput || !ctx.hasUI || !ctx.model) return;
    const baseUrl = String((ctx.model as { baseUrl?: string }).baseUrl ?? "");
    const isLocal = /127\.0\.0\.1|localhost|100\.\d+\.\d+\.\d+/i.test(baseUrl);
    if (isLocal && Array.isArray(ctx.model.input) && !ctx.model.input.includes("image")) {
      warnedVisionInput = true;
      ctx.ui.notify(
        `pi-vision-guard: ${ctx.model.provider}/${ctx.model.id} has input=["text"]; add "image" in ~/.pi/agent/models.json to enable screenshot vision reads.`,
        "warning",
      );
    }
  }

  pi.registerCommand("vision-guard", {
    description: "Show pi-vision-guard stats (flag rewrites, swept headless Chrome PIDs, model image input)",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      const supportsImage = model ? model.input.includes("image") : false;
      const msg = [
        `pi-vision-guard active (${process.platform})`,
        `- rewrites: ${rewriteCount}`,
        `- orphaned Chrome PIDs swept: ${sweptCount}`,
        `- active model: ${model ? `${model.provider}/${model.id} (input=${JSON.stringify(model.input)}, vision=${supportsImage})` : "none"}`,
        `- log: ${logPath ?? "disabled"}`,
      ].join("\n");
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "info");
      } else {
        process.stdout.write(`${msg}\n`);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    appendGuardLog(logPath, `session_start cwd=${ctx.cwd}`);
    warnIfLocalModelLacksImageInput(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    warnedVisionInput = false;
    warnIfLocalModelLacksImageInput(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCwd = ctx.cwd;
    if (process.platform !== "win32") return;
    return {
      systemPrompt: event.systemPrompt + WINDOWS_CHROME_SYSTEM_HINT,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    currentCwd = ctx.cwd;

    if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
      const cmd = typeof event.input.command === "string" ? event.input.command : "";
      if (!cmd) return;
      recordTargets(cmd);
      const res = sanitizeShellChromeCommand(cmd);
      if (res.changed) {
        event.input.command = res.command;
        rewriteCount += 1;
        appendGuardLog(logPath, `tool_call(${event.toolName}) rewritten: ${res.notes.join("; ")}`);
      }
      return;
    }

    if (isToolCallEventType("write", event)) {
      if (!isScriptFilePath(event.input.path)) return;
      recordTargets(event.input.content);
      const res = sanitizeScriptText(event.input.content);
      if (res.changed) {
        event.input.content = res.content;
        rewriteCount += 1;
        appendGuardLog(
          logPath,
          `tool_call(write ${String(event.input.path ?? "")}) rewritten: ${res.notes.join("; ")}`,
        );
      }
      return;
    }

    if (isToolCallEventType("edit", event)) {
      if (!isScriptFilePath(event.input.path)) return;
      const notes: string[] = [];
      for (const hunk of event.input.edits) {
        recordTargets(hunk.newText);
        const res = sanitizeScriptText(hunk.newText);
        if (res.changed) {
          hunk.newText = res.content;
          notes.push(...res.notes);
        }
      }
      if (notes.length > 0) {
        rewriteCount += 1;
        appendGuardLog(
          logPath,
          `tool_call(edit ${String(event.input.path ?? "")}) rewritten: ${notes.join("; ")}`,
        );
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const res = cleanupOrphanedHeadlessChrome({
      cwd: ctx.cwd || currentCwd,
      ports: trackedPorts,
      dirs: trackedDirs,
      reason: "agent_end",
      logPath,
    });
    sweptCount += res.killedPids.length;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const res = cleanupOrphanedHeadlessChrome({
      cwd: ctx.cwd || currentCwd,
      ports: trackedPorts,
      dirs: trackedDirs,
      reason: "session_shutdown",
      logPath,
    });
    sweptCount += res.killedPids.length;
  });
}
