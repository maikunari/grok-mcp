# grok-mcp

A minimal local MCP server (stdio) that lets Claude Desktop or Claude Code delegate
coding tasks to **Grok Build** running headless as a subagent.

Exposes one tool, `grok_task`:

| Input | Required | Description |
| --- | --- | --- |
| `prompt` | yes | The coding task for Grok Build |
| `cwd` | yes | Absolute path to the target repo/directory |
| `model` | no | Grok model ID. Default: `grok-composer-2.5-fast` (Composer 2.5) |
| `permission_mode` | no | Per-task `--permission-mode` (`default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`) |

Under the hood it runs:

```
grok --no-auto-update -p "<prompt>" -m <model> --output-format json
```

with the process `cwd` set to your target repo and your full user environment, so grok
uses your existing OAuth login cached in `~/.grok` (no `XAI_API_KEY` needed or used).

> **Note on the default model:** `composer-2.5` is **not** a valid Grok model ID — grok
> rejects it with `unknown model id` (verified against Grok Build 0.2.87). The actual ID
> for "Composer 2.5" is `grok-composer-2.5-fast`, which is the default here.
> Run `grok models` to see what's available.

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
| `GROK_TASK_TIMEOUT_MS` | `900000` (15 min) | Per-task timeout |
| `GROK_BIN` | `~/.grok/bin/grok` (falls back to `grok` on PATH) | Path to the grok binary |

## Output

On success the tool returns:

- Grok's final response text
- Files modified and commands run — extracted from the session transcript in
  `~/.grok/sessions/` (the headless JSON output itself doesn't include tool calls;
  verified on 0.2.87). Best effort: if the transcript can't be read, these show
  "none detected" but the response text is unaffected.
- Stop reason and session ID (resume the session later with `grok --resume <id>`)

If grok's JSON output can't be parsed, the raw stdout is returned instead. On failure,
stderr is included; auth-looking failures return:
`Grok Build auth expired — run \`grok login\` in a terminal, then retry.`

## Avoiding approval stalls (headless permission handling)

Grok's default "ask" permission behavior can stall a headless run — there is no UI to
answer the approval prompt, so the task just hangs until the timeout kills it.

**Important — verified against Grok Build 0.2.87 docs:** a project-scoped
`<repo>/.grok/config.toml` **cannot** carry permission settings. Grok only reads
`[mcp_servers]` from project-scoped config files; permission mode is only honored in the
**global** `~/.grok/config.toml`. Your options, from broadest to most surgical:

1. **Global auto-approve** (check yours with `grep permission_mode ~/.grok/config.toml`).
   In `~/.grok/config.toml`:

   ```toml
   [ui]
   permission_mode = "always-approve"
   ```

   Note this applies to *all* grok sessions, including interactive ones.

2. **Per-task override**: pass `permission_mode` on the `grok_task` call
   (e.g. `"acceptEdits"` to auto-approve file edits only, or `"bypassPermissions"`
   for everything). This maps to grok's headless-only `--permission-mode` flag and
   affects only that one run — the closest available equivalent to a per-repo opt-in.

3. **Do nothing** and accept that tasks needing approvals may hit the timeout.

The server never creates or modifies any config file. Before each run it checks whether
global auto-approve is set; if it isn't and no `permission_mode` was passed, the result
includes a warning pointing here. If a task hits the timeout, the error message also
points here, since a pending approval prompt is the most likely cause.

## Auth

Uses your existing Grok Build OAuth login (token cached in `~/.grok/auth.json`). If a
task fails with the auth-expired message, run `grok login` in a terminal and retry.

## License

MIT
