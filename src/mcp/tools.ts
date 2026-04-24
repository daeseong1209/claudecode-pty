import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { KEY_NAMES, resolveKey } from '../keys.js'
import type { PTYManager } from '../pty/manager.js'
import { compileSafePattern } from '../safe-regex.js'
import { extractCommands } from '../shell-parse.js'
import {
  formatKilled,
  formatReadPayload,
  formatSessionList,
  formatSessionSummary,
  formatSpawned,
  type KillOutcome,
} from '../format.js'
import { checkPermission } from '../permissions.js'
import type { AppConfig } from '../config.js'

const KEY_TUPLE = [KEY_NAMES[0]!, ...KEY_NAMES.slice(1)] as [string, ...string[]]

type TextContent = { type: 'text'; text: string }
type ToolResult = { content: TextContent[]; isError?: boolean }

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export function registerTools(
  server: McpServer,
  manager: PTYManager,
  config: AppConfig
): void {
  // -------------------- pty_spawn --------------------
  server.registerTool(
    'pty_spawn',
    {
      title: 'Spawn a PTY session',
      description: [
        'Spawn a long-lived PTY (pseudo-terminal) session that runs in the background.',
        'Use this INSTEAD of running long-running processes through a synchronous shell tool.',
        'Returns an ID (pty_xxxx) used by every other pty_* tool.',
        '',
        'Good fits: dev servers, build watches, REPLs, test runners, tunnels.',
        '',
        'Defaults: 120x40 terminal, no timeout, no exit notification, inherits current workdir.',
        'Set `timeoutSeconds` for commands that should finish on their own (builds, tests).',
        'Set `notifyOnExit: true` to get a log notification instead of polling with pty_read.',
      ].join('\n'),
      inputSchema: {
        command: z.string().describe('Executable to run (e.g. "npm", "python3", "bash").'),
        args: z
          .array(z.string())
          .default([])
          .describe('Argument list (e.g. ["run", "dev"]).'),
        description: z
          .string()
          .min(3)
          .max(200)
          .describe('Short (5-15 words) human-readable description of what this session is for.'),
        workdir: z
          .string()
          .optional()
          .describe('Working directory. Defaults to the server process cwd.'),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe('Additional environment variables, merged on top of the current environment.'),
        cols: z.number().int().positive().max(500).optional().describe('Terminal columns (default 120).'),
        rows: z.number().int().positive().max(500).optional().describe('Terminal rows (default 40).'),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'If set, PTY is killed automatically after this many seconds. Prefer for builds/tests; omit for dev servers and REPLs.'
          ),
        notifyOnExit: z
          .boolean()
          .default(false)
          .describe(
            'If true, an MCP log notification is emitted when the process exits. Prefer this over polling.'
          ),
      },
    },
    async (args): Promise<ToolResult> => {
      const perm = checkPermission(config, args.command, args.args ?? [])
      if (perm.action === 'deny') {
        return err(`PTY spawn denied: ${perm.reason}`)
      }
      try {
        const session = manager.spawn({
          command: args.command,
          args: args.args,
          workdir: args.workdir,
          env: args.env,
          description: args.description,
          cols: args.cols,
          rows: args.rows,
          notifyOnExit: args.notifyOnExit,
          timeoutSeconds: args.timeoutSeconds,
        })
        return ok(formatSpawned(session.toInfo()))
      } catch (e) {
        return err(`pty_spawn failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  // -------------------- pty_write --------------------
  server.registerTool(
    'pty_write',
    {
      title: 'Write text to a PTY (optionally submitting it)',
      description: [
        'Write text to a running PTY. Useful for typing commands, pasting content,',
        'or responding to prompts.',
        '',
        'Set `submit: true` to append "\\n" automatically — the common "type a command',
        'and hit Enter" pattern. This replaces the older `pty_write + pty_send_key Enter`',
        "two-call dance with a single call. Default is false so you can still paste",
        "partial text without submitting.",
        '',
        'To send Ctrl+C / arrow keys / function keys use `pty_send_key` — named keys',
        'are safer than guessing escape sequences.',
        '',
        'Best-effort permission check: the parser understands quoting, pipes, redirects,',
        'env-prefixes, `$()` / backticks / `<()` / `>()` substitution, subshells, brace',
        'groups, bash keywords (`if`/`for`/`case`/...), and command wrappers (`exec`/`env`/',
        '`nice`/...). It is NOT a full shell. For hard guarantees, deny shell entry-points',
        '(`bash`/`sh`/`zsh`/`pwsh`) at `pty_spawn` time.',
      ].join('\n'),
      inputSchema: {
        id: z.string().describe('PTY session ID (e.g. pty_a1b2c3d4).'),
        text: z
          .string()
          .describe('Text to send. Characters are sent as-is; no escape expansion.'),
        submit: z
          .boolean()
          .default(false)
          .describe(
            'If true, append a trailing "\\n" so the command is submitted. Default false (raw paste).'
          ),
      },
    },
    async (args): Promise<ToolResult> => {
      const session = manager.get(args.id)
      if (!session) return err(`PTY session '${args.id}' not found. Use pty_list to see active sessions.`)
      if (session.status !== 'running') {
        return err(`Cannot write to PTY '${args.id}': status is '${session.status}'.`)
      }
      const payload = args.submit ? `${args.text}\n` : args.text
      for (const cmd of extractCommands(payload)) {
        const perm = checkPermission(config, cmd.command, cmd.args)
        if (perm.action === 'deny') {
          return err(`pty_write denied (best-effort): ${perm.reason}`)
        }
      }
      const success = session.write(payload)
      if (!success) return err(`Failed to write to PTY '${args.id}'.`)
      const preview = payload.length > 80 ? `${payload.slice(0, 80)}…` : payload
      const display = preview.replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      return ok(
        `Sent ${payload.length} bytes to ${args.id}${args.submit ? ' (with trailing newline)' : ''}: "${display}"`
      )
    }
  )

  // -------------------- pty_send_key --------------------
  server.registerTool(
    'pty_send_key',
    {
      title: 'Send a named key or key sequence to a PTY',
      description: [
        'Send one or more named keys to a running PTY. Named keys are safer than raw bytes:',
        'you get Enter, Tab, CtrlC, CtrlD, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End,',
        'PageUp, PageDown, F1-F12, and every Ctrl+A..Ctrl+Z.',
        '',
        'Common patterns:',
        '  - Submit a typed command: pty_write "npm test" then pty_send_key "Enter"',
        '  - Interrupt a process: pty_send_key "CtrlC"',
        '  - Scroll up in a TUI: pty_send_key "ArrowUp" with count=5',
      ].join('\n'),
      inputSchema: {
        id: z.string().describe('PTY session ID (e.g. pty_a1b2c3d4).'),
        key: z.enum(KEY_TUPLE).describe('Named key. One of: ' + KEY_NAMES.join(', ')),
        count: z.number().int().positive().max(100).default(1).describe('Repeat count (default 1, max 100).'),
      },
    },
    async (args): Promise<ToolResult> => {
      const session = manager.get(args.id)
      if (!session) return err(`PTY session '${args.id}' not found.`)
      if (session.status !== 'running') {
        return err(`Cannot send key to PTY '${args.id}': status is '${session.status}'.`)
      }
      const seq = resolveKey(args.key)
      if (seq === null) {
        return err(`Unknown key '${args.key}'. Valid keys: ${KEY_NAMES.join(', ')}`)
      }
      const payload = seq.repeat(args.count)
      const success = session.write(payload)
      if (!success) return err(`Failed to send key to PTY '${args.id}'.`)
      return ok(`Sent key '${args.key}' × ${args.count} to ${args.id}`)
    }
  )

  // -------------------- pty_read --------------------
  server.registerTool(
    'pty_read',
    {
      title: 'Read lines from a PTY buffer',
      description: [
        "Read lines from a PTY session's buffer. Three modes:",
        '  1. Range read: omit `tail` and `pattern`. Returns `limit` lines starting at `offset`.',
        '  2. Tail read: set `tail=N`. Returns the last N lines.',
        '  3. Grep: set `pattern` to a regex. Returns only matching lines, paginated by offset/limit.',
        '',
        'Line numbers in the output are absolute (they persist across buffer truncation).',
        '',
        'Regex safety: patterns flagged as potentially catastrophic (nested quantifiers,',
        'runaway alternation) are rejected. The search is also capped at 100k lines per call.',
        '',
        'If the session was started with notifyOnExit=true, prefer waiting for the exit log',
        'message over polling with pty_read.',
      ].join('\n'),
      inputSchema: {
        id: z.string().describe('PTY session ID.'),
        offset: z.number().int().nonnegative().default(0).describe('Line number to start from (0-indexed among visible lines). Ignored when `tail` is set.'),
        limit: z.number().int().positive().max(5000).default(500).describe('Max lines to return (default 500, max 5000).'),
        tail: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe('If set, returns the last N visible lines. Overrides `offset`.'),
        pattern: z
          .string()
          .optional()
          .describe('Regex pattern. When set, only matching lines are returned, then offset/limit apply.'),
        ignoreCase: z.boolean().default(false).describe('Case-insensitive pattern matching.'),
        stripAnsi: z
          .boolean()
          .default(false)
          .describe(
            'If true, strip ANSI escape sequences (colors, cursor moves, bracketed-paste markers) from returned lines. Use this when you just want the plain text. The raw bytes remain in the buffer.'
          ),
      },
    },
    async (args): Promise<ToolResult> => {
      const session = manager.get(args.id)
      if (!session) return err(`PTY session '${args.id}' not found.`)

      const info = session.toInfo()

      if (args.pattern) {
        let compiled
        try {
          compiled = compileSafePattern(args.pattern, args.ignoreCase)
        } catch (e) {
          return err(`pty_read: ${e instanceof Error ? e.message : String(e)}`)
        }
        const result = session.buffer.search(compiled.regex, {
          offset: args.offset,
          limit: args.limit,
        })
        const hasMore = args.offset + result.matches.length < result.totalMatches
        return ok(
          formatReadPayload(info, result.matches, {
            mode: 'grep',
            offset: args.offset,
            limit: args.limit,
            totalLines: info.lineCount,
            hasMore,
            pattern: args.pattern,
            matchCount: result.totalMatches,
            searchTruncated: result.truncated,
            stripAnsi: args.stripAnsi,
          })
        )
      }

      if (args.tail !== undefined) {
        const lines = session.buffer.readTail(args.tail)
        return ok(
          formatReadPayload(info, lines, {
            mode: 'tail',
            offset: info.lineCount - lines.length,
            limit: args.tail,
            totalLines: info.lineCount,
            hasMore: false,
            stripAnsi: args.stripAnsi,
          })
        )
      }

      const lines = session.buffer.readLines(args.offset, args.limit)
      const hasMore = args.offset + lines.length < info.lineCount
      return ok(
        formatReadPayload(info, lines, {
          mode: 'range',
          offset: args.offset,
          limit: args.limit,
          totalLines: info.lineCount,
          hasMore,
          stripAnsi: args.stripAnsi,
        })
      )
    }
  )

  // -------------------- pty_wait --------------------
  server.registerTool(
    'pty_wait',
    {
      title: 'Block until a PTY event happens',
      description: [
        'Efficiently wait for an event on a PTY session instead of polling with pty_read.',
        '',
        'Specify one or more of: `pattern` (regex that should appear in a newly appended',
        "line), `untilExit` (true → resolve when the process exits), `idleMs` (resolve",
        "when no new output arrives for this many milliseconds). Whichever fires first",
        "wins. `timeoutSeconds` is required and bounds the maximum wait.",
        '',
        'Returns a structured report:',
        '  - reason=pattern  → the matching line (absolute line number + text)',
        '  - reason=exit     → exit code and signal',
        '  - reason=idle     → quiet period elapsed',
        '  - reason=timeout  → absolute timeout elapsed first (NOT an error)',
        '',
        'Agent token savings: one pty_wait call replaces dozens of pty_read polling',
        'rounds when waiting for a build/test/prompt.',
      ].join('\n'),
      inputSchema: {
        id: z.string().describe('PTY session ID.'),
        pattern: z
          .string()
          .optional()
          .describe(
            'Regex pattern; when a newly appended line matches, resolve with reason="pattern".'
          ),
        ignoreCase: z
          .boolean()
          .default(false)
          .describe('Case-insensitive pattern matching.'),
        untilExit: z
          .boolean()
          .default(false)
          .describe(
            'If true, also resolve when the process exits with reason="exit". Already-exited sessions resolve immediately.'
          ),
        idleMs: z
          .number()
          .int()
          .positive()
          .max(600_000)
          .optional()
          .describe(
            'If set, resolve with reason="idle" when no new output has arrived for this many ms (useful for REPL prompt detection).'
          ),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(3600)
          .default(60)
          .describe(
            'Hard upper bound on the wait. Default 60s, max 3600s. Timeout is reported as reason="timeout", not an error.'
          ),
      },
    },
    async (args): Promise<ToolResult> => {
      const session = manager.get(args.id)
      if (!session) return err(`PTY session '${args.id}' not found.`)

      let regex: RegExp | undefined
      if (args.pattern) {
        try {
          const compiled = compileSafePattern(args.pattern, args.ignoreCase)
          regex = compiled.regex
        } catch (e) {
          return err(`pty_wait: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (!regex && !args.untilExit && args.idleMs === undefined) {
        return err(
          'pty_wait: must specify at least one of `pattern`, `untilExit=true`, or `idleMs`.'
        )
      }

      const timeoutMs = args.timeoutSeconds * 1000

      // If untilExit is false and the session is already exited, there's no
      // point in waiting for pattern/idle — return immediately with exit info.
      if (!args.untilExit && session.status !== 'running') {
        const info = session.toInfo()
        return ok(
          [
            '<pty_wait>',
            `Session: ${args.id}`,
            `Reason: exit (session was already ${info.status} before wait started)`,
            `Status: ${info.status}`,
            `Exit Code: ${info.exitCode ?? 'null (signal-killed)'}`,
            `Signal: ${info.exitSignal ?? 'none'}`,
            `Elapsed: 0ms`,
            '</pty_wait>',
          ].join('\n')
        )
      }

      const result = await session.waitFor({
        pattern: regex,
        idleMs: args.idleMs,
        timeoutMs,
      })

      // If the caller didn't ask for untilExit but the process exited anyway,
      // we still report it — they probably want to know.
      const lines = [
        '<pty_wait>',
        `Session: ${args.id}`,
        `Reason: ${result.reason}`,
        `Status: ${result.status}`,
      ]
      if (result.reason === 'pattern' && result.match) {
        lines.push(`Match line: ${result.match.lineNumber + 1}`)
        lines.push(`Match text: ${result.match.text.length > 300 ? result.match.text.slice(0, 300) + '…' : result.match.text}`)
      }
      if (result.reason === 'exit') {
        lines.push(`Exit Code: ${result.exitCode ?? 'null (signal-killed)'}`)
        lines.push(`Signal: ${result.signal ?? 'none'}`)
      }
      lines.push(`Elapsed: ${result.elapsedMs}ms`)
      lines.push('</pty_wait>')
      return ok(lines.join('\n'))
    }
  )

  // -------------------- pty_list --------------------
  server.registerTool(
    'pty_list',
    {
      title: 'List PTY sessions',
      description:
        'List all known PTY sessions (running, exited, killed). Exited sessions remain listed until you kill them with cleanup=true.',
      inputSchema: {
        status: z
          .enum(['running', 'exited', 'killing', 'killed'])
          .optional()
          .describe('Filter by status.'),
      },
    },
    async (args): Promise<ToolResult> => {
      const sessions = manager.list(args.status ? { status: args.status } : undefined)
      const infos = sessions.map((s) => s.toInfo())
      return ok(formatSessionList(infos))
    }
  )

  // -------------------- pty_kill --------------------
  server.registerTool(
    'pty_kill',
    {
      title: 'Kill a PTY session',
      description: [
        'Terminate a PTY session. Defaults to SIGTERM.',
        '',
        '- cleanup=false (default): kill the process and keep the session + buffer in the list so you can read final output.',
        '- cleanup=true: kill the process; when the process actually exits the session is removed from the registry.',
        '  (For already-exited sessions, cleanup=true removes them immediately.)',
        '',
        'If the child traps SIGTERM, the server escalates to SIGKILL after a 5-second grace period.',
        'To send Ctrl+C (interrupt rather than signal), use pty_send_key with key="CtrlC" instead.',
      ].join('\n'),
      inputSchema: {
        id: z.string().describe('PTY session ID.'),
        cleanup: z.boolean().default(false).describe('If true, remove the session after it actually exits (frees buffer).'),
        signal: z
          .enum(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'])
          .default('SIGTERM')
          .describe('Signal to send. SIGKILL cannot be trapped.'),
      },
    },
    async (args): Promise<ToolResult> => {
      const session = manager.get(args.id)
      if (!session) return err(`PTY session '${args.id}' not found.`)
      const infoBefore = session.toInfo()
      const outcome = manager.kill(args.id, args.cleanup, args.signal)
      if (outcome === 'not_found') return err(`pty_kill: session '${args.id}' not found.`)
      // Use pre-kill snapshot for wording; status may already have moved.
      const killOutcome: KillOutcome = outcome
      return ok(formatKilled(infoBefore, killOutcome, args.cleanup))
    }
  )

  // -------------------- pty_resize --------------------
  server.registerTool(
    'pty_resize',
    {
      title: 'Resize a PTY',
      description:
        'Change the terminal size of a running PTY. Useful when a TUI reads COLUMNS/LINES or when output is being wrapped awkwardly. Rejects non-running sessions.',
      inputSchema: {
        id: z.string().describe('PTY session ID.'),
        cols: z.number().int().positive().max(500).describe('New column count.'),
        rows: z.number().int().positive().max(500).describe('New row count.'),
      },
    },
    async (args): Promise<ToolResult> => {
      const session = manager.get(args.id)
      if (!session) return err(`PTY session '${args.id}' not found.`)
      try {
        session.resize(args.cols, args.rows)
      } catch (e) {
        return err(`pty_resize failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      return ok(formatSessionSummary(session.toInfo()).join('\n'))
    }
  )
}
