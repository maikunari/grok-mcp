# grok-mcp

A minimal local MCP server (stdio) that lets Claude Desktop or Claude Code delegate
coding tasks to **Grok Build** running headless as a subagent.

Built for supervising agents: results are ground-truthed against git (no phantom
"files modified"), failures are honest failures, long tasks run as background jobs,
and every result carries a machine-readable `structuredContent` payload.

## Tools

### `grok_task`

| Input | Required | Description |
| --- | --- | --- |
| `prompt` | yes | The coding task for Grok Build |
| `cwd` | yes | Absolute path to the target repo/directory |
| `model` | no | Grok model ID, validated up front. Default: `grok-4.5` |
| `permission_mode` | no | See [permissions](#headless-permissions-verified-behavior) below |
| `session_id` | no | Session UUID from a previous result — resumes that session with context intact |
| `background` | no | `true` → return immediately with a `job_id`; poll `grok_task_result` |
| `timeout_ms` | no | Per-task timeout (default 15 min, clamped 10 s – 2 h) |
| `effort` | no | `low` / `medium` / `high` (maps to grok's `--effort`). Default: `high` |

Runs `grok --no-auto-update -p "<prompt>" -m <model> -s <uuid> --output-format json`
(`-r <uuid>` when resuming) with the process `cwd` set to your target repo and your
full user environment, so grok uses your existing OAuth login cached in `~/.grok`
(no `XAI_API_KEY` needed or used).

**For anything non-trivial, pass `background: true`.** MCP clients time out long
synchronous requests (typically ~60 s); a timed-out request looks like an error while
the task keeps running and editing files. Background mode sidesteps that entirely. If
a synchronous call does get cancelled mid-run, the job keeps running and the response
tells you the `job_id` to fetch later — and synchronous runs send MCP progress
notifications, which keeps clients that support them from timing out at all.

### `grok_task_result`

Fetch the outcome of a job: `job_id` (required), `max_wait_ms` (default 25 s, max 50 s
per call — call repeatedly while it reports `running`).

### `grok_task_status`

Non-blocking status. Pass `job_id` for one job, omit to list all known jobs.

### `grok_task_cancel`

Kill a queued or running job (`SIGTERM`, then `SIGKILL`). Returns the git-verified
partial changes the run left on disk. Finished jobs are unaffected.

**Job records persist to `~/.grok-mcp/jobs/`** (last 100), so `grok_task_result`
still works after a server restart — including the Claude Desktop restart that a
server upgrade requires. A job that was mid-run when the server died is reported as
failed with stop reason `ServerRestart` and instructions to verify via git or resume
the session; its outcome was not captured.

**Concurrency: jobs in the same `cwd` run strictly serially.** The git snapshot-diff
that makes `files_changed` trustworthy assumes one writer per working tree, and
parallel grok runs in one repo would conflict anyway. A second job dispatched into
the same directory is queued (the dispatch response says so, and behind which job);
different directories run in parallel freely.

### `grok_models`

Lists valid model IDs from grok's local model cache. `grok_task` also validates the
model up front and puts the valid IDs in the error message, with a "did you mean"
suggestion for near-misses (`composer-2.5` → `grok-composer-2.5-fast`).

## Result payload

Every result includes human-readable text plus `structuredContent`:

```json
{
  "v": 2,
  "success": true,
  "stop_reason": "EndTurn",
  "job_id": "6c8a1268-…",
  "session_id": "068253b9-…",
  "files_changed": ["a.txt", "b.txt", "c.txt"],
  "files_changed_source": "git",
  "diff_stat": " 2 files changed, 2 insertions(+), 2 deletions(-)",
  "commands_run": ["npm test"],
  "duration_ms": 28699,
  "model": "grok-4.5",
  "context_tokens_used": 21871,
  "tool_call_count": 4,
  "final_response": "…grok's own summary…",
  "response_truncated": false,
  "warnings": []
}
```

`v` is the payload schema version — check it before parsing if you depend on the
shape. `final_response` is capped at 16 000 chars (`response_truncated: true` when
cut). `context_tokens_used` / `tool_call_count` come from grok's session signals,
best effort — for budgeting when dispatching many jobs.

- **`files_changed` is ground truth, not narration**: the server snapshots
  `git status --porcelain -uall` before and after the run and diffs the two (plus
  `git diff --name-only` across any commits the task made). A dirty tree before the
  run is fine — only new changes are listed. `diff_stat` is scoped to those files.
  In non-git directories it falls back to parsing grok's session transcript and says
  so via `files_changed_source: "transcript"`.
- One deliberate blind spot: `git status --porcelain -uall` doesn't see edits to
  **gitignored** files (`.env.local`, build output, …). If a task only touches
  ignored files, `files_changed` is empty — by design, but worth knowing.
- **`success: false` means it**: any run ending with grok's `stopReason` other than
  `EndTurn` (`Cancelled`, or anything grok adds later) returns `isError: true` — even
  though grok exits 0 in those cases. Changes listed on that path are explicitly
  labeled **partial work**: the run stopped before grok considered the task done,
  and a cancel can land after some edits persisted.
- `commands_run` is best-effort transcript parsing (grok's headless output has no
  tool-call events), scoped to the current turn for resumed sessions.

## Prerequisites

- [Grok Build](https://grok.com) CLI installed (`grok` binary, default location `~/.grok/bin/grok`)
- Logged in via OAuth: run `grok login` once in a terminal
- Node.js 18+

## Install & build

```bash
git clone https://github.com/maikunari/grok-mcp.git
cd grok-mcp
npm install
npm run build
```

## Register in Claude Desktop

Add this to your Claude Desktop config (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), merging into an
existing `mcpServers` block if you have one, then fully quit and reopen Claude Desktop:

```json
{
  "mcpServers": {
    "grok": {
      "command": "node",
      "args": ["/absolute/path/to/grok-mcp/dist/index.js"]
    }
  }
}
```

> **Tip:** Claude Desktop launches MCP servers with a minimal `PATH`. If your `node`
> comes from nvm, Homebrew, or another version manager, use the absolute path to the
> node binary (find it with `which node`) as the `command` value instead of `"node"`.

## Register in Claude Code

```bash
claude mcp add --scope user grok -- node /absolute/path/to/grok-mcp/dist/index.js
```

(`--scope user` makes it available in every project; omit it to register for the
current project only. Takes effect in new sessions.)

## Configuration

Optional environment variables (add an `"env": { ... }` object to the server entry):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROK_TASK_TIMEOUT_MS` | `900000` (15 min) | Default per-task timeout (`timeout_ms` overrides per call) |
| `GROK_BIN` | `~/.grok/bin/grok` (falls back to `grok` on PATH) | Path to the grok binary |

## Headless permissions (verified behavior)

Headless grok has no TTY to answer approval prompts. Verified on Grok Build 0.2.87:
when a tool needs an approval nothing can grant, grok **cancels the run** — exit code
0, `stopReason: "Cancelled"`, no changes persisted. This server reports that as a
failure, never as a result.

Mode cheat-sheet for coding tasks:

| `permission_mode` | Headless behavior |
| --- | --- |
| `auto` | **Recommended first choice.** Edits + shell commands complete (verified here on grok 0.2.87–0.2.93, git and non-git dirs, sync and background). *However*: field reports exist of `auto` cancelling at the first write on other machines — likely grok-version or workspace-trust dependent. If your runs cancel under `auto`, escalate to `bypassPermissions` |
| `bypassPermissions` | Everything auto-approved — the only mode that suppresses every gate. The reliable mode for unattended coding, at the cost of a real trust expansion: grok approves all its own commands and writes in that cwd |
| `acceptEdits` | **Not headless-viable** — cancels at the first file write, creation *or* edit, even with no shell commands (verified). Despite the name, it appears to require an interactive UI |
| `default` / omitted | Uses the user's global config; cancels on any unapproved tool |

An explicit `permission_mode` **overrides** the user's global always-approve config —
passing `acceptEdits` makes runs fail even on machines where omitting it would work.

Alternative to per-call modes: enable global auto-approve in `~/.grok/config.toml`
(applies to *all* grok sessions, including interactive ones):

```toml
[ui]
permission_mode = "always-approve"
```

Note: a project-scoped `<repo>/.grok/config.toml` **cannot** carry permission
settings — grok only reads `[mcp_servers]` from project config (verified against
0.2.87 docs). The server never creates or modifies any config file; if no
auto-approval is detected, the result includes a warning instead.

## Auth

Uses your existing Grok Build OAuth login (token cached in `~/.grok/auth.json`). If a
task fails with the auth-expired message, run `grok login` in a terminal and retry.

## Development

`npm run test:cli` pins the grok CLI behavior this server depends on (3 short real
grok calls): `-s` creates new sessions and errors `already in use` on existing ones,
`-r` resumes with context. Grok's own README claims `-s` resumes — its `--help` is
correct and this server follows it. If grok ever changes `-s` to resume, this test
fails loudly instead of the server breaking quietly.

## License

MIT
