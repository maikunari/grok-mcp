#!/usr/bin/env node
// Pins the grok CLI session-flag semantics this server depends on
// (verified on Grok Build 0.2.87, where `grok --help` and the grok README
// disagree — --help is correct):
//
//   -s <uuid>  creates a NEW session; errors "already in use" if it exists
//   -r <uuid>  resumes an existing session with context intact
//
// If this script starts failing, grok changed the semantics underneath us —
// re-check src/index.ts (runJob picks -s vs -r based on the resume flag).
//
// Requires: grok installed + logged in. Makes 3 short real grok calls.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const GROK =
  process.env.GROK_BIN ?? join(homedir(), ".grok", "bin", "grok");
const dir = mkdtempSync(join(tmpdir(), "grok-mcp-regression-"));
const sid = randomUUID();
let failures = 0;

function grok(args) {
  try {
    return {
      out: execFileSync(GROK, ["--no-auto-update", "--output-format", "json", ...args], {
        cwd: dir,
        encoding: "utf8",
        timeout: 120_000,
      }),
      code: 0,
    };
  } catch (e) {
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// 1. -s with a fresh UUID creates a new session
const r1 = grok(["-p", "Remember this codeword and nothing else: zebra42. Reply OK.", "-s", sid]);
check("-s creates a new session", r1.code === 0 && JSON.parse(r1.out).sessionId === sid, r1.out.slice(0, 200));

// 2. -s with the SAME UUID must error (this is the behavior grok's README gets wrong)
const r2 = grok(["-p", "Reply OK.", "-s", sid]);
check(
  "-s on an existing session errors 'already in use'",
  r2.code !== 0 && /already in use/i.test(r2.out),
  `exit ${r2.code}: ${r2.out.slice(0, 200)}`
);

// 3. -r with the same UUID resumes with context
const r3 = grok(["-p", "Reply with ONLY the codeword from earlier in this session.", "-r", sid]);
const resumed = r3.code === 0 && JSON.parse(r3.out);
check(
  "-r resumes the session with context",
  resumed && resumed.sessionId === sid && /zebra42/.test(resumed.text),
  r3.out.slice(0, 200)
);

rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
