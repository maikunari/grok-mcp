import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Verified against Grok Build 0.2.87: `composer-2.5` is not a valid model ID
// ("unknown model id"); the real ID for Composer 2.5 is below.
const DEFAULT_MODEL = "grok-composer-2.5-fast";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TIMEOUT_MS =
  Number.parseInt(process.env.GROK_TASK_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;

// Claude Desktop spawns MCP servers with a minimal PATH that does not include
// ~/.grok/bin, so prefer the known install location. GROK_BIN overrides.
const GROK_HOME = join(homedir(), ".grok");
const GROK_BIN =
  process.env.GROK_BIN ??
  (existsSync(join(GROK_HOME, "bin", "grok")) ? join(GROK_HOME, "bin", "grok") : "grok");

// Headless-only flag values, from `grok --help` (0.2.87).
const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
];

const AUTH_ERROR_PATTERN =
  /unauthoriz|unauthenticat|not logged in|login required|authentication (failed|required)|token.{0,20}(expired|invalid|revoked)|expired.{0,20}token|\b401\b|please (run )?.{0,10}login/i;

const AUTH_HINT =
  "Grok Build auth expired — run `grok login` in a terminal, then retry.";

interface GrokRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runGrok(args: string[], cwd: string): Promise<GrokRunResult> {
  return new Promise((resolve, reject) => {
    // Full user environment so grok can read its cached OAuth token in ~/.grok.
    const child = spawn(GROK_BIN, args, { cwd, env: process.env });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// Grok's headless "ask" behavior only avoids stalling when approvals are
// auto-granted. Project-scoped .grok/config.toml can NOT carry permission
// settings (only [mcp_servers] is read there, per Grok Build docs), so the
// working knobs are the global ~/.grok/config.toml [ui] permission_mode key
// or the headless --permission-mode flag. This preflight just detects whether
// the global auto-approve is on so we can warn; it never modifies anything.
function globalAutoApproveEnabled(): boolean {
  try {
    const toml = readFileSync(join(GROK_HOME, "config.toml"), "utf8");
    return /^\s*permission_mode\s*=\s*"always-approve"\s*$/m.test(toml);
  } catch {
    return false;
  }
}

interface ToolCallSummary {
  filesModified: string[];
  commandsRun: string[];
}

// The headless JSON output has no tool-call info; grok records it in the
// session transcript. Best effort — returns empty lists if anything is off.
function readSessionToolCalls(cwd: string, sessionId: string): ToolCallSummary {
  const summary: ToolCallSummary = { filesModified: [], commandsRun: [] };
  try {
    const transcript = join(
      GROK_HOME,
      "sessions",
      encodeURIComponent(cwd),
      sessionId,
      "chat_history.jsonl"
    );
    const files = new Set<string>();
    const commands = new Set<string>();
    for (const line of readFileSync(transcript, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
      for (const call of msg.tool_calls) {
        let args: any = {};
        try {
          args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments ?? {};
        } catch {
          // keep going with what we have
        }
        const name = String(call.name ?? "").toLowerCase();
        if (name === "shell" || name === "run_terminal_cmd" || name === "bash") {
          if (args.command) commands.add(String(args.command));
        } else if (
          name === "write" ||
          name === "edit" ||
          name === "search_replace" ||
          name === "multiedit"
        ) {
          const path = args.path ?? args.file_path ?? args.target_file;
          if (path) files.add(String(path));
        }
      }
    }
    summary.filesModified = [...files];
    summary.commandsRun = [...commands];
  } catch {
    // transcript missing or unreadable — omit the details
  }
  return summary;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function grokTask(input: {
  prompt: string;
  cwd: string;
  model?: string;
  permission_mode?: string;
}) {
  const { prompt, model = DEFAULT_MODEL, permission_mode } = input;

  if (!isAbsolute(input.cwd)) {
    return textResult(`cwd must be an absolute path (got: ${input.cwd})`, true);
  }
  let cwd: string;
  try {
    cwd = realpathSync(input.cwd);
    if (!statSync(cwd).isDirectory()) {
      return textResult(`cwd is not a directory: ${input.cwd}`, true);
    }
  } catch {
    return textResult(`cwd does not exist: ${input.cwd}`, true);
  }
  if (permission_mode && !PERMISSION_MODES.includes(permission_mode)) {
    return textResult(
      `Invalid permission_mode "${permission_mode}". Valid values: ${PERMISSION_MODES.join(", ")}`,
      true
    );
  }

  const warnings: string[] = [];
  if (!permission_mode && !globalAutoApproveEnabled()) {
    warnings.push(
      "⚠️ No auto-approval configured: ~/.grok/config.toml has no `permission_mode = \"always-approve\"` " +
        "under [ui], and no permission_mode was passed for this task. The headless run may stall waiting " +
        "for an approval prompt nothing can answer. See \"Avoiding approval stalls\" in the grok-mcp README."
    );
  }

  const args = [
    "--no-auto-update",
    "-p",
    prompt,
    "-m",
    model,
    "--output-format",
    "json",
  ];
  if (permission_mode) args.push("--permission-mode", permission_mode);

  let run: GrokRunResult;
  try {
    run = await runGrok(args, cwd);
  } catch (err: any) {
    return textResult(
      `Failed to launch grok (${GROK_BIN}): ${err?.message ?? err}. ` +
        "Is Grok Build installed? Set GROK_BIN to the full path of the grok binary if needed.",
      true
    );
  }

  if (run.timedOut) {
    return textResult(
      `Grok task timed out after ${Math.round(TIMEOUT_MS / 60000)} minutes and was killed.\n\n` +
        "The most likely cause is a pending tool-approval prompt that nothing can answer in headless mode. " +
        'See "Avoiding approval stalls" in the grok-mcp README (global `permission_mode = "always-approve"` ' +
        "in ~/.grok/config.toml, or pass permission_mode on the task). For genuinely long tasks, raise " +
        "GROK_TASK_TIMEOUT_MS in the server config.\n\n" +
        (run.stdout ? `Partial stdout:\n${run.stdout.slice(-2000)}` : "No stdout produced."),
      true
    );
  }

  const combined = `${run.stdout}\n${run.stderr}`;

  // Grok can emit {"type":"error",...} on stdout (sometimes even with exit 0).
  let parsed: any = null;
  try {
    parsed = JSON.parse(run.stdout.trim());
  } catch {
    // not JSON — handled below
  }

  const failed = run.code !== 0 || parsed?.type === "error";
  if (failed) {
    if (AUTH_ERROR_PATTERN.test(combined)) {
      return textResult(AUTH_HINT, true);
    }
    const detail = parsed?.message ?? run.stderr.trim() ?? "";
    return textResult(
      `Grok task failed (exit code ${run.code}).\n\n` +
        (detail ? `Error: ${detail}\n\n` : "") +
        (run.stderr.trim() ? `stderr:\n${run.stderr.trim()}` : ""),
      true
    );
  }

  // JSON parsing failed on a successful run — return raw stdout as-is.
  if (parsed === null || typeof parsed !== "object") {
    return textResult(
      [...warnings, "Could not parse Grok JSON output; raw stdout below.", "", run.stdout].join("\n")
    );
  }

  const { filesModified, commandsRun } = parsed.sessionId
    ? readSessionToolCalls(cwd, parsed.sessionId)
    : { filesModified: [], commandsRun: [] };

  const lines: string[] = [];
  if (warnings.length) lines.push(...warnings, "");
  lines.push("## Grok task result", "", parsed.text ?? "(no response text)", "");
  lines.push(
    filesModified.length
      ? `**Files modified (${filesModified.length}):**\n${filesModified.map((f) => `- ${f}`).join("\n")}`
      : "**Files modified:** none detected"
  );
  lines.push(
    commandsRun.length
      ? `**Commands run (${commandsRun.length}):**\n${commandsRun.map((c) => `- \`${c}\``).join("\n")}`
      : "**Commands run:** none detected"
  );
  lines.push("");
  lines.push(`Stop reason: ${parsed.stopReason ?? "unknown"} · Session: ${parsed.sessionId ?? "unknown"}`);

  return textResult(lines.join("\n"));
}

const server = new Server(
  { name: "grok-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "grok_task",
      description:
        "Delegate a coding task to Grok Build (headless) as a subagent. Runs `grok -p` in the given " +
        "repository directory using the user's existing Grok OAuth login, waits for completion, and " +
        "returns the final response plus files modified and commands run.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The coding task for Grok Build to perform.",
          },
          cwd: {
            type: "string",
            description: "Absolute path to the target repository/directory the task should run in.",
          },
          model: {
            type: "string",
            description: `Grok model ID (default: ${DEFAULT_MODEL}). Run \`grok models\` to list valid IDs.`,
          },
          permission_mode: {
            type: "string",
            enum: PERMISSION_MODES,
            description:
              "Optional Grok permission mode for this task (maps to --permission-mode, headless only). " +
              "Omit to use Grok's default behavior.",
          },
        },
        required: ["prompt", "cwd"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "grok_task") {
    return textResult(`Unknown tool: ${request.params.name}`, true);
  }
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  if (typeof args.prompt !== "string" || !args.prompt.trim()) {
    return textResult("Missing required argument: prompt", true);
  }
  if (typeof args.cwd !== "string" || !args.cwd.trim()) {
    return textResult("Missing required argument: cwd", true);
  }
  try {
    return await grokTask({
      prompt: args.prompt,
      cwd: args.cwd,
      model: typeof args.model === "string" && args.model.trim() ? args.model : undefined,
      permission_mode:
        typeof args.permission_mode === "string" && args.permission_mode.trim()
          ? args.permission_mode
          : undefined,
    });
  } catch (err: any) {
    return textResult(`grok_task failed unexpectedly: ${err?.message ?? err}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`grok-mcp ready (grok binary: ${GROK_BIN}, timeout: ${TIMEOUT_MS}ms)`);
