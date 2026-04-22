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
      title: 'Write raw text to a PTY',
      description: [
        'Write raw text to a running PTY session. Useful for typing commands, pasting content,',
        'or responding to prompts. Text is sent as-is; no escape expansion.',
        '',
        'To send Enter/Ctrl+C/arrow keys, use pty_send_key instead — named keys are safer.',
        '',
        'Best-effort permission check: commands detected in the text are matched against the',
        'deny/allow config. The parser understands quoting, pipes, redirects, env-prefixes and',
        'recurses into $(...) / `...` substitutions, but it is NOT a full shell. For hard',
        'guarantees, deny shell entry-points (bash/sh/zsh/pwsh) at pty_spawn time.',
      ].join('\n'),
      inputSchema: {
        id: z.string().describe('PTY session ID (e.g. pty_a1b2c3d4).'),
        text: z.string().describe('Text to send. Include a trailing "\\n" if you want to submit a command line.'),
      },
    },
    async (args): Promise<ToolResult> => {
      const session = manager.get(args.id)
      if (!session) return err(`PTY session '${args.id}' not found. Use pty_list to see active sessions.`)
      if (session.status !== 'running') {
        return err(`Cannot write to PTY '${args.id}': status is '${session.status}'.`)
      }
      for (const cmd of extractCommands(args.text)) {
        const perm = checkPermission(config, cmd.command, cmd.args)
        if (perm.action === 'deny') {
          return err(`pty_write denied (best-effort): ${perm.reason}`)
        }
      }
      const success = session.write(args.text)
      if (!success) return err(`Failed to write to PTY '${args.id}'.`)
      const preview = args.text.length > 80 ? `${args.text.slice(0, 80)}…` : args.text
      const display = preview.replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      return ok(`Sent ${args.text.length} bytes to ${args.id}: "${display}"`)
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
        })
      )
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
