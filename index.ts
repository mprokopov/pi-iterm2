// @ts-nocheck
/**
 * iTerm2 Integration for Pi Coding Agent
 *
 * Provides native iTerm2 integration:
 * - Dynamic tab status badges (dot indicator, status label, and tool/detail message)
 *   matching iTerm2 and Claude Code conventions:
 *     - Working: Orange dot (#ff9500), "working", detail with current tool (e.g. bash, edit, read)
 *     - Waiting: Blue dot (#5f87ff), "waiting", detail with prompt/confirmation info
 *     - Idle: Green dot (#00d75f), "idle" / dim gray text (#888888), cleared detail
 * - Tab/Dock progress bar (OSC 9;4)
 * - Desktop notifications on completion and when waiting for user input (OSC 9)
 * - Dual-layer status updates:
 *     1. Direct terminal escape sequence (OSC 21337) with tmux passthrough
 *     2. iTerm2 native CLI (`it2 session set-status`) targeting the exact session ID
 * - Slash command `/iterm2` to check status, test indicators, or re-run setup
 */

import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Status configuration
const STATUS_CONFIG = {
  idle: {
    status: "idle",
    dotColor: "#00d75f",
    textColor: "#888888",
  },
  working: {
    status: "working",
    dotColor: "#ff9500",
    textColor: "#ff9500",
  },
  waiting: {
    status: "waiting",
    dotColor: "#5f87ff",
    textColor: "#5f87ff",
  },
} as const;

type StatusKind = keyof typeof STATUS_CONFIG;

// Progress states for OSC 9;4
const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const;

function isITerm2(): boolean {
  return (
    process.env.TERM_PROGRAM === "iTerm.app" ||
    process.env.LC_TERMINAL === "iTerm2" ||
    Boolean(process.env.ITERM_SESSION_ID)
  );
}

function getItermSessionId(): string | null {
  const raw = process.env.ITERM_SESSION_ID;
  if (!raw) return null;
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

let cachedIt2Path: string | null | undefined = undefined;

function resolveIt2(): string | null {
  if (cachedIt2Path !== undefined) {
    return cachedIt2Path;
  }

  // 1. Check native iTerm2 app bundle utility
  const nativeIt2 = "/Applications/iTerm.app/Contents/Resources/utilities/it2";
  if (fs.existsSync(nativeIt2)) {
    cachedIt2Path = nativeIt2;
    return nativeIt2;
  }

  // 2. Check cc-status symlink or utility
  const ccStatus = path.join(process.env.HOME || "", ".config", "iterm2", "cc-status");
  if (fs.existsSync(ccStatus)) {
    try {
      const target = fs.realpathSync(ccStatus);
      const siblingIt2 = path.join(path.dirname(target), "it2");
      if (fs.existsSync(siblingIt2)) {
        cachedIt2Path = siblingIt2;
        return siblingIt2;
      }
    } catch {}
  }

  // 3. Fallback to `which it2`
  try {
    const which = cp.execSync("which it2", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (which && fs.existsSync(which)) {
      cachedIt2Path = which;
      return which;
    }
  } catch {}

  cachedIt2Path = null;
  return null;
}

function wrapPassthrough(seq: string): string {
  if (process.env.TMUX) {
    return `\x1bPtmux;\x1b${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  }
  if (process.env.STY) {
    return `\x1bP${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  }
  return seq;
}

function writeToTerminal(seq: string): void {
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(wrapPassthrough(seq));
    }
  } catch {}
}

function escapeOscValue(val: string): string {
  return val.replaceAll("\\", "\\\\").replaceAll(";", "\\;");
}

let lastReportedStatus: StatusKind | null = null;
let lastReportedDetail: string | null = null;

function setTabStatus(kind: StatusKind, detail?: string): void {
  const config = STATUS_CONFIG[kind];
  if (!config) return;

  const cleanDetail = detail?.trim() || "";

  // Avoid redundant calls
  if (lastReportedStatus === kind && lastReportedDetail === cleanDetail) {
    return;
  }
  lastReportedStatus = kind;
  lastReportedDetail = cleanDetail;

  // 1. Emit OSC 21337 directly to terminal
  let osc = `\x1b]21337;status=${config.status};indicator=${config.dotColor};status-color=${config.textColor}`;
  if (cleanDetail) {
    osc += `;detail=${escapeOscValue(cleanDetail)}`;
  } else {
    osc += `;detail=`;
  }
  osc += `\x07`;
  writeToTerminal(osc);

  // 2. Call `it2 session set-status` asynchronously
  const it2 = resolveIt2();
  const sessionId = getItermSessionId();
  if (it2 && sessionId) {
    const args = [
      "session",
      "set-status",
      "--session",
      sessionId,
      "--status",
      config.status,
      "--dot-color",
      config.dotColor,
      "--text-color",
      config.textColor,
    ];
    if (cleanDetail) {
      args.push("--detail", cleanDetail);
    } else {
      args.push("--detail", "");
    }

    try {
      const child = cp.spawn(it2, args, {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {});
      child.unref();
    } catch {}
  }
}

function clearTabStatus(): void {
  lastReportedStatus = null;
  lastReportedDetail = null;
  writeToTerminal("\x1b]21337;status=;indicator=;detail=\x07");

  const it2 = resolveIt2();
  const sessionId = getItermSessionId();
  if (it2 && sessionId) {
    try {
      const child = cp.spawn(
        it2,
        [
          "session",
          "set-status",
          "--session",
          sessionId,
          "--status",
          "idle",
          "--dot-color",
          "#00d75f",
          "--text-color",
          "#888888",
          "--detail",
          "",
        ],
        { stdio: "ignore", detached: true },
      );
      child.on("error", () => {});
      child.unref();
    } catch {}
  }
}

function setProgressBar(action: number, percent?: number): void {
  if (action === PROGRESS.CLEAR) {
    writeToTerminal(`\x1b]9;4;${PROGRESS.CLEAR};\x07`);
  } else if (action === PROGRESS.INDETERMINATE) {
    writeToTerminal(`\x1b]9;4;${PROGRESS.INDETERMINATE};\x07`);
  } else if (action === PROGRESS.ERROR) {
    const pct = Math.max(0, Math.min(100, Math.round(percent ?? 100)));
    writeToTerminal(`\x1b]9;4;${PROGRESS.ERROR};${pct}\x07`);
  } else if (action === PROGRESS.SET) {
    const pct = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
    writeToTerminal(`\x1b]9;4;${PROGRESS.SET};${pct}\x07`);
  }
}

function sendNotification(message: string, title = "Pi"): void {
  const text = title ? `${title}: ${message}` : message;
  writeToTerminal(`\x1b]9;${text}\x07`);
}

function summarizeToolCall(toolName: string, args: any): string {
  if (!args || typeof args !== "object") {
    return toolName;
  }

  switch (toolName) {
    case "bash": {
      const cmd = typeof args.command === "string" ? args.command.trim().replace(/\s+/g, " ") : "";
      return cmd.length > 40 ? `bash: ${cmd.slice(0, 37)}…` : `bash: ${cmd}`;
    }
    case "read": {
      const file = typeof args.path === "string" ? path.basename(args.path) : "";
      return file ? `read: ${file}` : "read";
    }
    case "edit": {
      const file = typeof args.path === "string" ? path.basename(args.path) : "";
      return file ? `edit: ${file}` : "edit";
    }
    case "write": {
      const file = typeof args.path === "string" ? path.basename(args.path) : "";
      return file ? `write: ${file}` : "write";
    }
    case "intercom": {
      return args.action ? `intercom: ${args.action}` : "intercom";
    }
    default:
      return toolName;
  }
}

function condense(text: string, maxLen = 40): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

export default function (pi: ExtensionAPI) {
  if (!isITerm2()) {
    return;
  }

  let turnStartTime = 0;
  let isWorking = false;

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    setTabStatus("idle");
    setProgressBar(PROGRESS.CLEAR);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    isWorking = true;
    turnStartTime = Date.now();
    const detail = event.prompt ? condense(event.prompt, 40) : "Working…";
    setTabStatus("working", detail);
    setProgressBar(PROGRESS.INDETERMINATE);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    isWorking = true;
    setTabStatus("working", "Working…");
    setProgressBar(PROGRESS.INDETERMINATE);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    isWorking = true;
    const summary = summarizeToolCall(event.toolName, event.args);
    setTabStatus("working", summary);
    setProgressBar(PROGRESS.INDETERMINATE);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (isWorking) {
      setTabStatus("working", "Working…");
    }
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const detail = event.title ? condense(event.title, 40) : "Input needed";
    setTabStatus("waiting", detail);
    setProgressBar(PROGRESS.ERROR, 100);
    sendNotification(event.title || "Input needed");
  });

  pi.on("ui_prompt_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (ctx.isIdle?.()) {
      isWorking = false;
      setTabStatus("idle");
      setProgressBar(PROGRESS.CLEAR);
    } else {
      isWorking = true;
      setTabStatus("working", "Working…");
      setProgressBar(PROGRESS.INDETERMINATE);
    }
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    isWorking = false;
    setTabStatus("idle");
    setProgressBar(PROGRESS.CLEAR);

    // If turn took longer than 4s and wasn't aborted, notify user
    const duration = Date.now() - turnStartTime;
    if (!event.aborted && duration > 4000) {
      sendNotification("Task completed");
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    isWorking = false;
    clearTabStatus();
    setProgressBar(PROGRESS.CLEAR);
  });

  // Slash command `/iterm2`
  pi.registerCommand("iterm2", {
    description: "Inspect or test iTerm2 status integration",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const sub = args.trim().toLowerCase();
      const sessionId = getItermSessionId();
      const it2Path = resolveIt2();

      if (sub === "test") {
        ctx.ui.notify("Testing iTerm2 status indicators…", "info");

        setTabStatus("working", "Testing: working…");
        setProgressBar(PROGRESS.INDETERMINATE);
        await new Promise((r) => setTimeout(r, 1200));

        setTabStatus("waiting", "Testing: waiting for input…");
        setProgressBar(PROGRESS.ERROR, 100);
        sendNotification("Test notification: waiting for input");
        await new Promise((r) => setTimeout(r, 1200));

        setTabStatus("idle");
        setProgressBar(PROGRESS.CLEAR);
        sendNotification("Test complete!");
        ctx.ui.notify("iTerm2 test cycle finished!", "info");
        return;
      }

      if (sub === "clear") {
        clearTabStatus();
        setProgressBar(PROGRESS.CLEAR);
        ctx.ui.notify("Cleared iTerm2 status.", "info");
        return;
      }

      // Default: print status info
      const lines = [
        `iTerm2 detected: ${isITerm2() ? "Yes" : "No"}`,
        `Session ID: ${sessionId ?? "Not found"}`,
        `it2 CLI: ${it2Path ?? "Not found"}`,
        `Inside tmux: ${process.env.TMUX ? "Yes" : "No"}`,
        "",
        "Commands:",
        "  /iterm2 test   - Flash working -> waiting -> idle indicators",
        "  /iterm2 clear  - Reset tab status to default",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
