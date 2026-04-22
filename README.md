# claudecode-pty

Production-grade **MCP server** providing interactive PTY (pseudo-terminal) session management for [Claude Code](https://claude.com/claude-code). Spawn background processes, stream output, send input, and grep logs — all via seven focused MCP tools.

This is not a 1:1 port of [opencode-pty](https://github.com/shekohex/opencode-pty). It is a ground-up MCP-first redesign that fixes several performance and safety issues in the original (string-concat "ring" buffer, naive ReDoS checks, no backpressure, raw escape-sequence strings).

## Features

- **7 tools** with zod-validated schemas: `pty_spawn`, `pty_write`, `pty_send_key`, `pty_read`, `pty_list`, `pty_kill`, `pty_resize`
- **Real ring buffer** — line-oriented deque with O(chunk) appends, no O(N²) concat, ANSI-aware line splitting that ignores `\n` inside CSI/OSC/DCS sequences
- **ReDoS-safe grep** — patterns are filtered through `safe-regex2`, search is capped at 100k lines per call, and the `g` flag is stripped to prevent stateful bleed
- **Key enum** — `Enter`, `CtrlC`, `ArrowUp`, `F1–F12`, `Ctrl+A..Z`, etc. No more `\x03` guessing games
- **Timeout + auto-kill** per session
- **Truncation markers** — when the buffer overflows, a `<truncated bytes=N lines=M>` header tells the agent that older data was dropped
- **MCP logging notifications** for exit events (surface in the client if it supports logging; otherwise always visible via `pty_list`)
- **Permission allow/deny** — optional `~/.claudecode-pty/config.json` with shell-glob patterns; re-checked on every `pty_write` for defense-in-depth
- **Concurrency cap** — default 32 simultaneous running PTYs (configurable)
- **MCP resources** — `pty://sessions` for clients that browse state
- **TypeScript strict mode** — `noUncheckedIndexedAccess` on, full type coverage

## Install & Build

```bash
cd ~/claudecode-pty
npm install
npm run build
```

This compiles TypeScript and builds the `node-pty` native binding.

## Register with Claude Code

Add the MCP server at user scope so it's available across all your projects:

```bash
claude mcp add-json claudecode-pty '{"command":"node","args":["/root/claudecode-pty/dist/index.js"]}' --scope user
```

Or edit `~/.claude.json` directly:

```json
{
  "mcpServers": {
    "claudecode-pty": {
      "command": "node",
      "args": ["/root/claudecode-pty/dist/index.js"]
    }
  }
}
```

Verify registration:

```bash
claude mcp list
```

You should see `claudecode-pty` in the list. Restart any running Claude Code session; the seven `pty_*` tools appear in the model's tool manifest.

### Project-scoped alternative

If you only want the PTY tools inside one project, drop a `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "claudecode-pty": {
      "command": "node",
      "args": ["/root/claudecode-pty/dist/index.js"]
    }
  }
}
```

## Configuration

Optional `~/.claudecode-pty/config.json`:

```json
{
  "allow": ["npm **", "cargo **", "python3 **", "bash **"],
  "deny": ["rm -rf **", "git push **"],
  "defaultAction": "allow",
  "maxConcurrentSessions": 32,
  "ringBufferBytes": 1000000
}
```

### Pattern grammar (positional, as of v0.2.0)

Patterns are whitespace-separated tokens:

- First token = command head. `npm`, `bash`, `cargo`, etc. (Glob chars `*` and `?` allowed within a single token.)
- Remaining tokens = arguments, matched **positionally** against the actual argv.
- `*` matches **exactly one** argument (any single token).
- `**` matches **zero or more** arguments. Anything before it is a prefix; anything after is a suffix. At most one `**` per pattern.

Examples:

| Pattern | Matches | Does NOT match |
|---|---|---|
| `npm run dev` | `npm run dev` | `npm run build` (different arg), `npm run dev --port 3000` (extra arg) |
| `npm run *` | `npm run dev`, `npm run build` | `npm run dev --port 3000` (2 args vs 1 star) |
| `npm **` | `npm`, `npm run`, `npm run dev --foo bar` | `cargo build` |
| `git ** -- src/` | `git log -- src/`, `git log -n 5 -- src/` | `git log -- other/` |

Rules of thumb:
- Pin what you mean. `npm run dev` is stricter than `npm run *`.
- Use `**` when you genuinely want "any args".
- `defaultAction: "deny"` locks the plugin down — only `allow`-matched commands spawn.
- `deny` takes precedence over `allow`.
- Buffer size is per session. 1 MB (~20k lines at avg 50 chars) is the default.

### `pty_write` permission checks are best-effort

Detection happens through a small shell-aware parser that understands quoting, pipes, redirects, env-prefixes, and command substitution (`$()`, backticks). It is **not** a full shell. For hard guarantees, deny shell entry-points (`bash`, `sh`, `zsh`) at `pty_spawn` time.

## Usage (agent-facing examples)

**Spawn a dev server:**
```
pty_spawn(command="npm", args=["run", "dev"], description="Next.js dev server")
→ returns pty_a1b2c3d4
```

**Run tests with auto-notification and timeout:**
```
pty_spawn(command="npm", args=["test"], description="unit tests",
          notifyOnExit=true, timeoutSeconds=600)
→ pty_a1b2c3d4
# Agent waits for the notifications/message on exit.
```

**Tail the last 100 lines of a running server:**
```
pty_read(id="pty_a1b2c3d4", tail=100)
```

**Grep for errors in a build log:**
```
pty_read(id="pty_a1b2c3d4", pattern="error|failed", ignoreCase=true)
```

**Interrupt a process:**
```
pty_send_key(id="pty_a1b2c3d4", key="CtrlC")
```

**Type a command into a REPL:**
```
pty_write(id="pty_a1b2c3d4", text="println!(\"hi\")")
pty_send_key(id="pty_a1b2c3d4", key="Enter")
```

## Architecture

```
src/
├── index.ts              # stdio entry
├── server.ts             # MCP server setup, transport, wiring
├── format.ts             # XML-tag output formatting
├── safe-regex.ts         # ReDoS-safe regex compile
├── permissions.ts        # shell-glob allow/deny matcher
├── config.ts             # ~/.claudecode-pty/config.json loader
├── keys.ts               # Named-key → escape-sequence map
├── pty/
│   ├── types.ts          # Public + internal types
│   ├── ansi-lines.ts     # CSI/OSC/DCS-aware line parser
│   ├── ring-buffer.ts    # Line-oriented ring buffer
│   ├── session.ts        # One PTY + buffer + lifecycle
│   └── manager.ts        # Session registry with resource limits
└── mcp/
    ├── tools.ts          # 7 tool handlers (zod-validated)
    ├── resources.ts      # pty://sessions resource
    └── notifications.ts  # Exit log emission
```

## Differences from opencode-pty

| Concern | opencode-pty | claudecode-pty |
|---|---|---|
| Ring buffer | `string += data; slice(-max)` — O(N²) | Line-deque with moving head pointer — O(chunk) |
| Line splitting | `split('\n')` — ANSI-unaware | `AnsiLineParser` — skips CSI/OSC/DCS |
| ReDoS check | 3 hardcoded patterns | `safe-regex2` + 100k-line wall + `g` flag strip |
| Key input | Raw `\x03` strings | `pty_send_key` enum |
| Exit notification | `client.session.promptAsync` (OpenCode-specific) | MCP `notifications/message` (portable) |
| Backpressure | None | Drop-oldest with truncation markers |
| Tool count | 5 | 7 (added `pty_send_key`, `pty_resize`) |
| `pty_read` modes | range + grep (conflated) | range, tail, grep (explicit via `tail` / `pattern`) |
| Concurrency cap | None | Configurable (default 32) |
| Monkey patch | Yes (`bun-pty._startReadLoop`) | No |

## Testing

```bash
npm run build
npm test
```

Covers:
- `unit-ring-buffer`: append, read, tail, search, truncation, UTF-8
- `unit-ansi-lines`: CSI, OSC, DCS, cross-chunk state
- `unit-safe-regex`: catastrophic-pattern rejection
- `integration-mcp`: full MCP round-trip (initialize → tools/list → spawn → read → send_key → kill), including timeout and ReDoS rejection

## License

MIT
