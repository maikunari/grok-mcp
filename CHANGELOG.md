# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.3.2] - 2026-07-09

### Changed
- Default model is now `grok-4.5` (was `grok-composer-2.5-fast`). Pass
  `model: "grok-composer-2.5-fast"` to use Composer.
- Default effort is now `high` (was unset). Pass `effort: "low"` or `"medium"`
  to override. Matches Grok 4.5's recommended reasoning effort.

## [0.4.0] - 2026-07-09

Permission-mode truth pass (two field bug reports), plus new model/effort defaults.

### Changed
- **Default model is now `grok-4.5` with `effort: high`** (was
  `grok-composer-2.5-fast`, no effort flag). Pass `model: "grok-composer-2.5-fast"`
  and/or a lower `effort` per call to get the old behavior.
- **`acceptEdits` is not headless-viable at all** (verified on Grok Build 0.2.87):
  it cancels the run at the first file write — new file *or* edit, even with no
  shell commands. Previous docs claimed only shell commands killed it. The dispatch
  warning, Cancelled-failure hint, tool schema, and README mode table now say so,
  and note that an explicit `permission_mode` overrides the user's global
  always-approve config.
- **Cancelled failures now include a mode escalation path** (default → `auto` →
  `bypassPermissions`) naming the mode that was used, instead of a generic hint.
  A field report of `auto` cancelling at the first write could not be reproduced
  here (verified working on grok 0.2.87–0.2.93, git and non-git, sync and
  background, CLI and MCP) — the guidance and README now document both realities
  and `bypassPermissions` as the reliable fallback for unattended coding.
- Non-`EndTurn` failures include the grok process exit code and a stderr tail in
  both text and structured payload, so abnormal stops are diagnosable.
- Background dispatch no longer reports `status: "queued"` when the queue is
  empty and the job starts immediately.

### Added
- Regression checks pinning both permission-mode behaviors: `acceptEdits` cancels
  at the first write; `auto` completes writes headlessly in a git repo. If either
  flips in a future grok release, the guidance gets updated instead of silently
  rotting.

## [0.3.0] - 2026-07-06

Job lifecycle hardening, from a second round of field feedback.

### Added
- `grok_task_cancel` tool: kills a queued or running job (SIGTERM, then SIGKILL)
  and returns the git-verified partial changes it left on disk.
- Job persistence to `~/.grok-mcp/jobs/` (last 100 records): `grok_task_result`
  now works across server restarts. Jobs orphaned mid-run by a restart report
  `stop_reason: "ServerRestart"` with guidance to verify via git or resume the session.
- Per-cwd job serialization: a second job dispatched into the same directory is
  queued behind the first (`status: "queued"`, `queued_behind: [...]` in the dispatch
  response) so concurrent runs can't cross-contaminate `files_changed`. Different
  directories still run in parallel.
- `context_tokens_used` and `tool_call_count` in every result payload (best effort,
  from grok's session signals) for callers budgeting across many jobs.
- Schema version field (`"v": 2`) on all `structuredContent` payloads.
- `npm run test:cli`: regression test pinning the grok CLI `-s`/`-r` session
  semantics this server depends on.

### Changed
- All non-`EndTurn` stops (cancelled, timeout, caller-cancel, future stop reasons)
  label any listed changes as **partial, incomplete work** — never implying a clean no-op.
- `final_response` capped at 16 000 chars, with a `response_truncated` flag.

### Documented
- Gitignored files (`.env.local`, build output, …) are invisible to the git
  snapshot-diff behind `files_changed` — deliberate, now stated in the README.

## [0.2.0] - 2026-07-06

Trustworthy results and long-task support, addressing field feedback from an agent
that drove `grok_task` across a multi-phase coding project.

### Added
- Background jobs: `background: true` returns a `job_id` immediately; new
  `grok_task_result` and `grok_task_status` tools poll it. Long synchronous calls
  previously died on the MCP client's request timeout while grok kept editing files.
- MCP progress notifications during synchronous runs (when the client sends a
  progress token), and survival of client-side cancellation: the job keeps running
  and stays fetchable by `job_id`.
- Session continuation: `session_id` parameter resumes a previous grok session with
  context intact (via `-r`; grok's `-s` errors `already in use` on existing sessions,
  contrary to its bundled README — its `--help` is correct).
- Up-front model validation with the available IDs and a "did you mean" suggestion
  in the error; new `grok_models` tool.
- `structuredContent` payload on every result: `success`, `stop_reason`,
  `files_changed`, `diff_stat`, `commands_run`, `duration_ms`, session/job IDs,
  `final_response`, `warnings`.
- `timeout_ms` and `effort` parameters.

### Changed
- **Honest failure states**: grok exits 0 with `stopReason: "Cancelled"` when a
  permission prompt fires headlessly (verified) — previously reported as success
  with phantom "files modified". Any stop reason other than `EndTurn` now returns
  `isError: true` with verified on-disk changes.
- **`files_changed` is git ground truth**: `git status --porcelain -uall` snapshots
  before/after the run (plus commit-range diff if the task commits), replacing
  transcript parsing, which undercounted. `diff_stat` is scoped to this run's files
  so pre-existing dirt doesn't leak in. Transcript parsing remains only as the
  non-git fallback, labeled via `files_changed_source`.
- Session IDs are generated upfront and passed to grok, so even timed-out or
  cancelled runs are identifiable and resumable.

## [0.1.0] - 2026-07-06

Initial release.

### Added
- `grok_task` tool: delegates a coding task to Grok Build headless
  (`grok -p … --output-format json`) in a given directory, using the user's
  existing OAuth login (no `XAI_API_KEY`).
- Structured result summary: response text, files modified, commands run
  (parsed from the session transcript).
- Auth-expiry detection with a clear remediation message, configurable timeout
  (`GROK_TASK_TIMEOUT_MS`) with approval-stall hints, cwd validation, and
  stderr passthrough on failures.
- Registration instructions for Claude Desktop and Claude Code.

[0.3.2]: https://github.com/maikunari/grok-mcp/releases/tag/v0.3.2
[0.4.0]: https://github.com/maikunari/grok-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/maikunari/grok-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/maikunari/grok-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/maikunari/grok-mcp/releases/tag/v0.1.0
