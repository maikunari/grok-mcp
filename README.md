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
| `model` | no | Grok model ID, validated up front. Default: `grok-composer-2.5-fast` |
| `permission_mode` | no | See [permissions](#headless-permissions-verified-behavior) below |
| `session_id` | no | Session UUID from a previous result — resumes that session with context intact |
| `background` | no | `true` → return immediately with a `job_id`; poll `grok_task_result` |
| `timeout_ms` | no | Per-task timeout (default 15 min, clamped 10 s – 2 h) |
| `effort` | no | `low` / `medium` / `high` (maps to grok's `--effort`) |

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

Non-blocking status. Pass `job_id` for one job, omit to list all jobs from this
server session. (Jobs live in server memory — they don't survive a server restart.)

### `grok_models`

Lists valid model IDs from grok's local model cache. `grok_task` also validates the
model up front and puts the valid IDs in the error message, with a "did you mean"
suggestion for near-misses (`composer-2.5` → `grok-composer-2.5-fast`).

## Result payload

Every result includes human-readable text plus `structuredContent`:

```json
{
  "success": true,
  "stop_reason": "EndTurn",
  "job_id": "6c8a1268-…",
  "session_id": "068253b9-…",
  "files_changed": ["a.txt", "b.txt", "c.txt"],
  "files_changed_source": "git",
  "diff_stat": " 2 files changed, 2 insertions(+), 2 deletions(-)",
  "commands_run": ["npm test"],
  "duration_ms": 28699,
  "model": "grok-composer-2.5-fast",
  "final_response": "…grok's own summary…",
  "warnings": []
}
```

- **`files_changed` is ground truth, not narration**: the server snapshots
  `git status --porcelain -uall` before and after the run and diffs the two (plus
  `git diff --name-only` across any commits the task made). A dirty tree before the
  run is fine — only new changes are listed. `diff_stat` is scoped to those files.
  In non-git directories it falls back to parsing grok's session transcript and says
  so via `files_changed_source: "transcript"`.
- **`success: false` means it**: a run that ends with grok's `stopReason` anything
  other than `EndTurn` (e.g. `Cancelled`) returns `isError: true` with the verified
  on-disk changes — even though grok exits 0 in that case.
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
| `auto` | **Recommended.** Edits + shell commands complete (verified) |
| `bypassPermissions` | Everything auto-approved |
| `acceptEdits` | Edits only — the first shell command **cancels the whole run** (verified) |
| `default` / omitted | Uses the user's global config; cancels on any unapproved tool |

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

## License

MIT
