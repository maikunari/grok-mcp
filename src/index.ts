import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Verified against Grok Build 0.2.87: `composer-2.5` is not a valid model ID
// ("unknown model id"); the real ID for Composer 2.5 is below.
const DEFAULT_MODEL = "grok-composer-2.5-fast";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const ENV_TIMEOUT_MS =
  Number.parseInt(process.env.GROK_TASK_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;
const MAX_JOBS_KEPT = 50;

// Claude Desktop spawns MCP servers with a minimal PATH that does not include
// ~/.grok/bin, so prefer the known install location. GROK_BIN overrides.
const GROK_HOME = join(homedir(), ".grok");
const GROK_BIN =
  process.env.GROK_BIN ??
  (existsSync(join(GROK_HOME, "bin", "grok")) ? join(GROK_HOME, "bin", "grok") : "grok");

// Headless-only flag values, from `grok --help` (0.2.87). Verified behavior:
// modes that leave any tool un-approved don't stall headless runs — grok
// CANCELS them (stopReason "Cancelled", exit 0, no changes persisted).
// "acceptEdits" cancels as soon as the task runs a shell command; "auto"
// completes edits + commands. So auto/bypassPermissions are headless-viable
// for coding tasks; acceptEdits only for pure-edit tasks.
const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
];
const EFFORT_LEVELS = ["low", "medium", "high"];

const AUTH_ERROR_PATTERN =
  /unauthoriz|unauthenticat|not logged in|login required|authentication (failed|required)|token.{0,20}(expired|invalid|revoked)|expired.{0,20}token|\b401\b|please (run )?.{0,10}login/i;

const AUTH_HINT =
  "Grok Build auth expired — run `grok login` in a terminal, then retry.";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// git ground truth
// ---------------------------------------------------------------------------

interface GitSnapshot {
  isRepo: boolean;
  head: string | null;
  status: Map<string, string>; // path -> XY status
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? r.stdout : null;
}

function gitSnapshot(cwd: string): GitSnapshot {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return { isRepo: false, head: null, status: new Map() };
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim() ?? null;
  const status = new Map<string, string>();
  const out = git(cwd, ["status", "--porcelain", "-uall"]);
  if (out !== null) {
    for (const line of out.split("\n")) {
      if (line.length < 4) continue;
      const xy = line.slice(0, 2);
      let path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4); // renames: keep new path
      status.set(path.replace(/^"|"$/g, ""), xy);
    }
  }
  return { isRepo: true, head, status };
}

interface GitDelta {
  filesChanged: string[];
  diffStat: string | null;
  madeCommits: boolean;
  preDirty: boolean;
}

function gitDelta(cwd: string, before: GitSnapshot, after: GitSnapshot): GitDelta {
  const files = new Set<string>();
  for (const [path, xy] of after.status) {
    if (before.status.get(path) !== xy) files.add(path);
  }
  const madeCommits = before.head !== after.head;
  if (madeCommits && before.head) {
    const committed = git(cwd, ["diff", "--name-only", `${before.head}..HEAD`]);
    for (const f of committed?.split("\n") ?? []) if (f.trim()) files.add(f.trim());
  }
  // Limit the stat to files THIS run changed, so pre-existing dirt in the
  // tree doesn't leak into the summary. Untracked files don't appear in
  // git diff; the files list above is the authoritative count.
  let diffStat: string | null = null;
  const base = madeCommits && before.head ? before.head : after.head ? "HEAD" : null;
  if (base && files.size > 0) {
    const stat = git(cwd, ["diff", "--stat", base, "--", ...[...files].slice(0, 200)]);
    if (stat?.trim()) diffStat = stat.trim().split("\n").slice(-1)[0];
  }
  return {
    filesChanged: [...files],
    diffStat,
    madeCommits,
    preDirty: before.status.size > 0,
  };
}

// ---------------------------------------------------------------------------
// session transcript (best effort; commands only — files come from git)
// ---------------------------------------------------------------------------

function readSessionCommands(cwd: string, sessionId: string): string[] {
  try {
    const transcript = join(
      GROK_HOME,
      "sessions",
      encodeURIComponent(cwd),
      sessionId,
      "chat_history.jsonl"
    );
    const messages: any[] = [];
    for (const line of readFileSync(transcript, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    // Only count tool calls after the LAST user query, so resumed sessions
    // don't re-report commands from earlier turns.
    let lastUser = 0;
    messages.forEach((m, i) => {
      if (m.type === "user") lastUser = i;
    });
    const commands = new Set<string>();
    for (const m of messages.slice(lastUser)) {
      if (m.type !== "assistant" || !Array.isArray(m.tool_calls)) continue;
      for (const call of m.tool_calls) {
        const name = String(call.name ?? "").toLowerCase();
        if (name !== "shell" && name !== "run_terminal_cmd" && name !== "bash") continue;
        try {
          const args =
            typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
          if (args?.command) commands.add(String(args.command));
        } catch {
          // skip
        }
      }
    }
    return [...commands];
  } catch {
    return [];
  }
}

// Transcript fallback for file lists in non-git directories.
function readSessionFiles(cwd: string, sessionId: string): string[] {
  try {
    const transcript = join(
      GROK_HOME,
      "sessions",
      encodeURIComponent(cwd),
      sessionId,
      "chat_history.jsonl"
    );
    const files = new Set<string>();
    for (const line of readFileSync(transcript, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type !== "assistant" || !Array.isArray(m.tool_calls)) continue;
      for (const call of m.tool_calls) {
        const name = String(call.name ?? "").toLowerCase();
        if (!/write|edit|search_replace|patch|apply/.test(name)) continue;
        try {
          const args =
            typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
          const path = args?.path ?? args?.file_path ?? args?.target_file;
          if (path) files.add(String(path));
        } catch {
          // skip
        }
      }
    }
    return [...files];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// model registry (from grok's local cache; best effort)
// ---------------------------------------------------------------------------

interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

function loadModels(): ModelInfo[] {
  try {
    const cache = JSON.parse(readFileSync(join(GROK_HOME, "models_cache.json"), "utf8"));
    return Object.values<any>(cache.models ?? {})
      .map((m) => m.info)
      .filter((i) => i && !i.hidden)
      .map((i) => ({ id: i.id, name: i.name ?? i.id, description: i.description ?? "" }));
  } catch {
    return [];
  }
}

function validateModel(model: string): string | null {
  const models = loadModels();
  if (models.length === 0) return null; // no cache — let grok decide
  if (models.some((m) => m.id === model)) return null;
  const guess = models.find(
    (m) =>
      m.id === `grok-${model}` || m.id === `${model}-fast` || m.id === `grok-${model}-fast`
  );
  return (
    `Unknown model '${model}'. Available: ${models.map((m) => m.id).join(", ")}.` +
    (guess ? ` Did you mean '${guess.id}'?` : "")
  );
}

// ---------------------------------------------------------------------------
// permission preflight
// ---------------------------------------------------------------------------

function globalAutoApproveEnabled(): boolean {
  try {
    const toml = readFileSync(join(GROK_HOME, "config.toml"), "utf8");
    return /^\s*permission_mode\s*=\s*"always-approve"\s*$/m.test(toml);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// job engine
// ---------------------------------------------------------------------------

interface ToolResult {
  [key: string]: unknown;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Job {
  id: string;
  sessionId: string;
  cwd: string;
  model: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  result?: ToolResult;
  done: Promise<void>;
}

const jobs = new Map<string, Job>();

function gcJobs() {
  if (jobs.size <= MAX_JOBS_KEPT) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const j of finished.slice(0, jobs.size - MAX_JOBS_KEPT)) jobs.delete(j.id);
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

function structured(
  text: string,
  data: Record<string, unknown>,
  isError = false
): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: data, isError };
}

interface StartOpts {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode?: string;
  sessionId: string;
  resume: boolean;
  timeoutMs: number;
  effort?: string;
  warnings: string[];
}

function startJob(opts: StartOpts): Job {
  const id = randomUUID();
  const before = gitSnapshot(opts.cwd);

  // -s only creates NEW sessions (errors with "already in use" on an existing
  // ID — verified; grok's --help is authoritative here, its README is not).
  // Continuation therefore uses -r/--resume.
  const args = [
    "--no-auto-update",
    "-p",
    opts.prompt,
    "-m",
    opts.model,
    opts.resume ? "-r" : "-s",
    opts.sessionId,
    "--output-format",
    "json",
  ];
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.effort) args.push("--effort", opts.effort);

  const job: Job = {
    id,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    model: opts.model,
    status: "running",
    startedAt: Date.now(),
    done: Promise.resolve(),
  };

  job.done = new Promise<void>((resolveDone) => {
    let child;
    try {
      child = spawn(GROK_BIN, args, { cwd: opts.cwd, env: process.env });
    } catch (err: any) {
      finish(
        textResult(
          `Failed to launch grok (${GROK_BIN}): ${err?.message ?? err}. Set GROK_BIN if needed.`,
          true
        ),
        "failed"
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      clearTimeout(timer);
      finish(
        textResult(
          `Failed to launch grok (${GROK_BIN}): ${err?.message ?? err}. Set GROK_BIN if needed.`,
          true
        ),
        "failed"
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish(
        buildResult({ opts, before, code, stdout, stderr, timedOut, job }),
        undefined
      );
    });

    function finish(result: ToolResult, forceStatus?: "failed") {
      if (job.status !== "running") return;
      job.result = result;
      job.status = forceStatus ?? (result.isError ? "failed" : "completed");
      job.finishedAt = Date.now();
      resolveDone();
      gcJobs();
    }
  });

  jobs.set(id, job);
  return job;
}

function buildResult(ctx: {
  opts: StartOpts;
  before: GitSnapshot;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  job: Job;
}): ToolResult {
  const { opts, before, code, stdout, stderr, timedOut, job } = ctx;
  const durationMs = Date.now() - job.startedAt;
  const after = gitSnapshot(opts.cwd);
  const delta = before.isRepo ? gitDelta(opts.cwd, before, after) : null;
  const filesChanged = delta
    ? delta.filesChanged
    : readSessionFiles(opts.cwd, opts.sessionId);
  const commandsRun = readSessionCommands(opts.cwd, opts.sessionId);

  const base: Record<string, unknown> = {
    success: false,
    job_id: job.id,
    session_id: opts.sessionId,
    files_changed: filesChanged,
    files_changed_source: delta ? "git" : "transcript",
    diff_stat: delta?.diffStat ?? null,
    commands_run: commandsRun,
    duration_ms: durationMs,
    model: opts.model,
  };

  const changesNote = delta
    ? filesChanged.length
      ? `**Files changed (${filesChanged.length}, git-verified):**\n${filesChanged.map((f) => `- ${f}`).join("\n")}` +
        (delta.diffStat ? `\n**Diff:** ${delta.diffStat}` : "") +
        (delta.madeCommits ? "\n(note: the task created git commits)" : "") +
        (delta.preDirty
          ? "\n(note: tree was dirty before the run; list shows new changes only)"
          : "")
      : "**Files changed:** none (git-verified)"
    : filesChanged.length
      ? `**Files changed (${filesChanged.length}, from transcript — not a git repo, unverified):**\n${filesChanged.map((f) => `- ${f}`).join("\n")}`
      : "**Files changed:** none detected (not a git repo; transcript-based)";

  const commandsNote = commandsRun.length
    ? `**Commands run (${commandsRun.length}):**\n${commandsRun.map((c) => `- \`${c}\``).join("\n")}`
    : "**Commands run:** none detected";

  const footer = `Session: ${opts.sessionId} · Job: ${job.id} · Duration: ${Math.round(durationMs / 1000)}s`;

  if (timedOut) {
    return structured(
      `❌ Grok task timed out after ${Math.round(opts.timeoutMs / 60000)} minutes and was killed.\n\n` +
        "If this was a genuinely long task, raise timeout_ms (or GROK_TASK_TIMEOUT_MS) and consider " +
        "background: true. If it hung early, a pending approval prompt is the likely cause — use " +
        'permission_mode: "auto" or enable global always-approve (see README "Avoiding approval stalls").\n\n' +
        `Changes on disk before the kill:\n${changesNote}\n\n${footer}\n\n` +
        `You can resume this session later by passing session_id: "${opts.sessionId}".`,
      { ...base, stop_reason: "Timeout" },
      true
    );
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // not JSON
  }

  if (code !== 0 || parsed?.type === "error") {
    const combined = `${stdout}\n${stderr}`;
    if (AUTH_ERROR_PATTERN.test(combined)) {
      return structured(AUTH_HINT, { ...base, stop_reason: "AuthError" }, true);
    }
    const detail = parsed?.message ?? stderr.trim();
    return structured(
      `❌ Grok task failed (exit code ${code}).\n\n` +
        (detail ? `Error: ${detail}\n\n` : "") +
        (stderr.trim() ? `stderr:\n${stderr.trim()}\n\n` : "") +
        footer,
      { ...base, stop_reason: "Error", exit_code: code },
      true
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    return structured(
      `Grok exited 0 but produced unparseable output; raw stdout below.\n\n${stdout}\n\n${footer}`,
      { ...base, stop_reason: "UnparseableOutput", raw_stdout: stdout.slice(0, 20000) },
      true
    );
  }

  const stopReason = String(parsed.stopReason ?? "unknown");

  // Exit code 0 does NOT mean success: grok reports Cancelled with exit 0
  // when a permission prompt fires headlessly (verified on 0.2.87).
  if (stopReason !== "EndTurn") {
    const permHint =
      stopReason === "Cancelled"
        ? "\n\nLikely cause: a tool needed an approval no one could answer headlessly, so grok " +
          `cancelled the run (permission_mode was ${opts.permissionMode ? `"${opts.permissionMode}"` : "grok's default"}). ` +
          'Note "acceptEdits" only auto-approves file edits — any shell command cancels the run. ' +
          'For coding tasks use permission_mode: "auto" (or "bypassPermissions"), or enable global always-approve.'
        : "";
    return structured(
      `❌ Grok task did NOT complete (stop reason: ${stopReason}). Treat this as a failure — ` +
        `partial output below is not a result summary.${permHint}\n\n` +
        `Grok's last message:\n${parsed.text ?? "(none)"}\n\n` +
        `Actual changes on disk (verify before trusting):\n${changesNote}\n\n${footer}`,
      { ...base, stop_reason: stopReason, final_response: parsed.text ?? null },
      true
    );
  }

  const warningBlock = opts.warnings.length ? opts.warnings.join("\n") + "\n\n" : "";
  return structured(
    `${warningBlock}## Grok task result\n\n${parsed.text ?? "(no response text)"}\n\n` +
      `${changesNote}\n${commandsNote}\n\n${footer} · Stop reason: EndTurn\n` +
      `To iterate on this work with context intact, pass session_id: "${opts.sessionId}" to the next grok_task call.`,
    {
      ...base,
      success: true,
      stop_reason: stopReason,
      final_response: parsed.text ?? null,
      warnings: opts.warnings,
    },
    false
  );
}

// ---------------------------------------------------------------------------
// tool handlers
// ---------------------------------------------------------------------------

async function handleGrokTask(args: Record<string, unknown>, extra: any): Promise<ToolResult> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const cwdArg = typeof args.cwd === "string" ? args.cwd.trim() : "";
  if (!prompt) return textResult("Missing required argument: prompt", true);
  if (!cwdArg) return textResult("Missing required argument: cwd", true);
  if (!isAbsolute(cwdArg)) {
    return textResult(`cwd must be an absolute path (got: ${cwdArg})`, true);
  }

  let cwd: string;
  try {
    cwd = realpathSync(cwdArg);
    if (!statSync(cwd).isDirectory()) {
      return textResult(`cwd is not a directory: ${cwdArg}`, true);
    }
  } catch {
    return textResult(`cwd does not exist: ${cwdArg}`, true);
  }

  const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : DEFAULT_MODEL;
  const modelError = validateModel(model);
  if (modelError) return textResult(modelError, true);

  const permissionMode =
    typeof args.permission_mode === "string" && args.permission_mode ? args.permission_mode : undefined;
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) {
    return textResult(
      `Invalid permission_mode "${permissionMode}". Valid values: ${PERMISSION_MODES.join(", ")}`,
      true
    );
  }

  const effort = typeof args.effort === "string" && args.effort ? args.effort : undefined;
  if (effort && !EFFORT_LEVELS.includes(effort)) {
    return textResult(`Invalid effort "${effort}". Valid values: ${EFFORT_LEVELS.join(", ")}`, true);
  }

  let sessionId: string;
  let resume = false;
  if (typeof args.session_id === "string" && args.session_id.trim()) {
    sessionId = args.session_id.trim();
    resume = true;
    if (!UUID_PATTERN.test(sessionId)) {
      return textResult(
        `session_id must be a UUID (got: ${sessionId}). Use the session_id from a previous grok_task result.`,
        true
      );
    }
  } else {
    sessionId = randomUUID();
  }

  const timeoutMs = Math.min(
    Math.max(typeof args.timeout_ms === "number" ? args.timeout_ms : ENV_TIMEOUT_MS, 10_000),
    2 * 60 * 60 * 1000
  );

  const warnings: string[] = [];
  if (!permissionMode && !globalAutoApproveEnabled()) {
    warnings.push(
      "⚠️ No auto-approval configured (no global always-approve in ~/.grok/config.toml and no " +
        "permission_mode on this call). If the task needs any tool approval, grok will CANCEL the " +
        'run headlessly. Consider permission_mode: "auto".'
    );
  }
  if (permissionMode === "acceptEdits") {
    warnings.push(
      '⚠️ permission_mode "acceptEdits" auto-approves file edits only — if the task runs any shell ' +
        'command, grok cancels the whole run (verified). Use "auto" for coding tasks that may run commands.'
    );
  }

  const job = startJob({ prompt, cwd, model, permissionMode, sessionId, resume, timeoutMs, effort, warnings });

  if (args.background === true) {
    return structured(
      `Grok task started in background.\n\nJob: ${job.id}\nSession: ${sessionId}\n\n` +
        (warnings.length ? warnings.join("\n") + "\n\n" : "") +
        `Poll with grok_task_result (job_id: "${job.id}") — it waits up to max_wait_ms (default 25s) ` +
        "per call and returns the final result when done.",
      { success: true, job_id: job.id, session_id: sessionId, status: "running", warnings }
    );
  }

  // Synchronous path: keep the connection alive with progress notifications
  // (if the client sent a progressToken) and survive client-side cancellation —
  // the job keeps running and stays fetchable via grok_task_result.
  const progressToken = extra?._meta?.progressToken ?? extra?.requestInfo?._meta?.progressToken;
  let ticker: ReturnType<typeof setInterval> | undefined;
  if (progressToken !== undefined && typeof extra?.sendNotification === "function") {
    ticker = setInterval(() => {
      extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: Math.round((Date.now() - job.startedAt) / 1000),
            message: `grok task running (${Math.round((Date.now() - job.startedAt) / 1000)}s)`,
          },
        })
        .catch(() => {});
    }, 10_000);
  }

  try {
    if (extra?.signal) {
      await Promise.race([
        job.done,
        new Promise<void>((res) => extra.signal.addEventListener("abort", () => res(), { once: true })),
      ]);
    } else {
      await job.done;
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }

  if (job.status === "running") {
    // Client cancelled/timed out the request; the task continues.
    return structured(
      `Request was cancelled by the client but the grok task IS STILL RUNNING.\n\n` +
        `Job: ${job.id}\nSession: ${sessionId}\n\n` +
        `Fetch the outcome with grok_task_result (job_id: "${job.id}"). Do not assume anything ` +
        "about repo state until that returns.",
      { success: false, job_id: job.id, session_id: sessionId, status: "running" },
      true
    );
  }
  return job.result!;
}

function jobStatusText(job: Job): string {
  const elapsed = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
  return `Job ${job.id}: ${job.status} (${elapsed}s) · Session: ${job.sessionId} · cwd: ${job.cwd}`;
}

async function handleTaskResult(args: Record<string, unknown>): Promise<ToolResult> {
  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  const job = jobs.get(jobId);
  if (!job) {
    return textResult(
      `Unknown job_id: ${jobId || "(missing)"}. Known jobs:\n` +
        ([...jobs.values()].map(jobStatusText).join("\n") || "(none — jobs do not survive server restarts)"),
      true
    );
  }
  const maxWait = Math.min(
    Math.max(typeof args.max_wait_ms === "number" ? args.max_wait_ms : 25_000, 0),
    50_000
  );
  if (job.status === "running" && maxWait > 0) {
    await Promise.race([job.done, new Promise((res) => setTimeout(res, maxWait))]);
  }
  if (job.status === "running") {
    return structured(
      `Still running (${Math.round((Date.now() - job.startedAt) / 1000)}s elapsed). ` +
        `Call grok_task_result again with job_id: "${job.id}".`,
      { job_id: job.id, session_id: job.sessionId, status: "running" }
    );
  }
  return job.result!;
}

async function handleTaskStatus(args: Record<string, unknown>): Promise<ToolResult> {
  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  if (jobId) {
    const job = jobs.get(jobId);
    if (!job) return textResult(`Unknown job_id: ${jobId}`, true);
    return structured(jobStatusText(job), {
      job_id: job.id,
      session_id: job.sessionId,
      status: job.status,
      elapsed_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
    });
  }
  const all = [...jobs.values()];
  return structured(
    all.length ? all.map(jobStatusText).join("\n") : "No jobs this server session.",
    { jobs: all.map((j) => ({ job_id: j.id, session_id: j.sessionId, status: j.status })) }
  );
}

async function handleModels(): Promise<ToolResult> {
  const models = loadModels();
  if (!models.length) {
    return textResult(
      "No model cache found at ~/.grok/models_cache.json — run any grok command once to populate it.",
      true
    );
  }
  return structured(
    models
      .map((m) => `- ${m.id}${m.id === DEFAULT_MODEL ? " (default)" : ""} — ${m.name}: ${m.description}`)
      .join("\n"),
    { models, default: DEFAULT_MODEL }
  );
}

// ---------------------------------------------------------------------------
// server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "grok-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "grok_task",
      description:
        "Delegate a coding task to Grok Build (headless) as a subagent. Runs in the given repository " +
        "using the user's existing Grok OAuth login. Returns grok's response plus a git-verified list " +
        "of files changed and commands run. For tasks likely to exceed ~1 minute, pass background: true " +
        "and poll grok_task_result — long synchronous calls can hit the MCP client's request timeout. " +
        "To continue a previous task with context intact, pass its session_id.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The coding task for Grok Build to perform." },
          cwd: {
            type: "string",
            description: "Absolute path to the target repository/directory the task should run in.",
          },
          model: {
            type: "string",
            description: `Grok model ID (default: ${DEFAULT_MODEL}). Use grok_models to list valid IDs.`,
          },
          permission_mode: {
            type: "string",
            enum: PERMISSION_MODES,
            description:
              'Grok permission mode. Headless-viable for coding tasks: "auto" (recommended) or ' +
              '"bypassPermissions". "acceptEdits" cancels the run if the task executes any shell command. ' +
              "Omit to use grok's default (relies on the user's global config).",
          },
          session_id: {
            type: "string",
            description:
              "Session UUID from a previous grok_task result. Resumes that session so grok keeps its " +
              "context (files read, decisions made) instead of starting cold.",
          },
          background: {
            type: "boolean",
            description:
              "If true, return immediately with a job_id; fetch the outcome with grok_task_result. " +
              "Recommended for anything non-trivial.",
          },
          timeout_ms: {
            type: "number",
            description: `Per-task timeout in ms (default ${ENV_TIMEOUT_MS}, clamped to 10s–2h).`,
          },
          effort: {
            type: "string",
            enum: EFFORT_LEVELS,
            description: "Grok effort level (maps to --effort).",
          },
        },
        required: ["prompt", "cwd"],
      },
    },
    {
      name: "grok_task_result",
      description:
        "Fetch the result of a grok_task job (background, or one whose request timed out). Waits up to " +
        "max_wait_ms for completion, then returns either the final result or a still-running status. " +
        "Safe to call repeatedly.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID returned by grok_task." },
          max_wait_ms: {
            type: "number",
            description: "How long to wait for completion before returning (default 25000, max 50000).",
          },
        },
        required: ["job_id"],
      },
    },
    {
      name: "grok_task_status",
      description:
        "Check status of grok_task jobs without blocking. Pass job_id for one job, omit it to list all " +
        "jobs from this server session.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Optional job ID to check." },
        },
      },
    },
    {
      name: "grok_models",
      description: "List available Grok model IDs (from grok's local model cache).",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const meta = { ...(extra ?? {}), _meta: request.params._meta };
  try {
    switch (request.params.name) {
      case "grok_task":
        return await handleGrokTask(args, meta);
      case "grok_task_result":
        return await handleTaskResult(args);
      case "grok_task_status":
        return await handleTaskStatus(args);
      case "grok_models":
        return await handleModels();
      default:
        return textResult(`Unknown tool: ${request.params.name}`, true);
    }
  } catch (err: any) {
    return textResult(`${request.params.name} failed unexpectedly: ${err?.message ?? err}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`grok-mcp v0.2.0 ready (grok binary: ${GROK_BIN}, default timeout: ${ENV_TIMEOUT_MS}ms)`);
