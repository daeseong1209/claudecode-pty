/**
 * Best-effort shell statement/token extractor for defense-in-depth permission
 * checks on pty_write. This is NOT a full shell parser — it understands enough
 * to avoid the most common false-negative bypasses.
 *
 * Coverage (v0.2.1):
 *   - Single / double / backtick quoting (no splitting inside)
 *   - `&&`, `||`, `;`, `|`, `&` as top-level separators
 *   - `>`, `>>`, `<`, `<<` redirections (target token skipped)
 *   - `$(cmd)` / `` `cmd` `` / `<(cmd)` / `>(cmd)` recursive extraction
 *   - Subshell `(cmd)` and group `{ cmd; }` unwrap so inner commands get checked
 *   - Bash keywords `if / elif / then / else / while / until / do / for / select /
 *     case / in / esac / time / !` are skipped so the real command is extracted
 *   - Absolute/relative command-path basename normalization (so `/bin/rm` matches
 *     a rule keyed on `rm`)
 *   - `FOO=bar cmd args` env-prefix stripping (including indexed-array prefixes
 *     like `arr[0]=x`)
 *   - `#` line comments outside quotes
 *
 * Known gaps (documented, not fixed here): heredoc bodies are re-scanned as if
 * they were commands (false-positive deny only, not a bypass), split writes
 * across multiple `pty_write` calls are not reassembled, and brace expansion
 * `{a,b}` is not evaluated.
 *
 * Always treat the output of this parser as a best-effort signal; for hard
 * guarantees deny shell entry-points at `pty_spawn`.
 */

import { basename } from 'node:path'

export interface ExtractedCommand {
  command: string
  args: string[]
}

const BASH_KEYWORDS = new Set([
  'if',
  'elif',
  'then',
  'else',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'for',
  'select',
  'case',
  'esac',
  'in',
  'time',
  '!',
  'coproc',
  '{',
  '}',
])

/**
 * Wrapper commands whose first positional arg is itself a command to execute.
 * We strip these heads so the inner command becomes the permission-check head.
 * `function` is handled as a two-token strip (`function NAME`) separately.
 */
const COMMAND_WRAPPERS = new Set(['exec', 'env', 'command', 'builtin', 'nice', 'nohup', 'ionice'])

const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=/

/**
 * Return the command head as the matcher should see it:
 *   `/bin/rm` → `rm`, `./scripts/deploy.sh` → `deploy.sh`, `rm` → `rm`.
 * Does not touch tokens without a slash.
 */
export function normalizeCommandHead(cmd: string): string {
  if (!cmd.includes('/')) return cmd
  const base = basename(cmd)
  return base.length > 0 ? base : cmd
}

export function extractCommands(data: string): ExtractedCommand[] {
  const out: ExtractedCommand[] = []
  for (const rawLine of data.split(/\r?\n|\r/)) {
    collectFromLine(rawLine, out)
  }
  return out
}

function collectFromLine(line: string, out: ExtractedCommand[]): void {
  const stripped = stripLineComment(line).trim()
  if (!stripped) return

  for (const inner of extractSubstitutions(stripped)) {
    collectFromLine(inner, out)
  }

  for (const statement of splitStatements(stripped)) {
    collectFromStatement(statement, out)
  }
}

function collectFromStatement(statement: string, out: ExtractedCommand[]): void {
  let current = statement.trim()
  if (!current) return

  // Unwrap subshell `(cmd)` or brace group `{ cmd; }`. We use a "while it peels,
  // keep peeling" loop so there's no depth cap to bypass. The loop is
  // naturally bounded by the string shrinking each iteration, and
  // unwrapGroup returns the same string when there's nothing to peel, so it
  // always terminates.
  while (true) {
    const unwrapped = unwrapGroup(current)
    if (unwrapped === current) break
    current = unwrapped.trim()
    if (!current) return
  }

  // If the current string still has top-level `(...)` or `{...}` groups in
  // the *middle* (not wrapping the whole thing), extract them and recurse so
  // adjacent-group shapes like `(rm -rf /) (echo safe)` don't slip through.
  // Only bother if the trimmed string still contains such a group.
  if (current.includes('(') || current.includes('{')) {
    const pieces = splitTopLevelGroups(current)
    if (pieces.length > 1) {
      for (const p of pieces) collectFromStatement(p, out)
      return
    }
  }

  // After unwrap, the current string may hold multiple statements (e.g. after
  // stripping parens around `rm a; rm b`). Re-split and recurse.
  const substatements = splitStatements(current)
  if (substatements.length > 1 || (substatements.length === 1 && substatements[0] !== current)) {
    for (const s of substatements) collectFromStatement(s, out)
    return
  }

  const tokens = tokenize(current)
  let i = 0

  // Loop until the next token is a plain command token. We alternate between
  // env-prefix strip, bash-keyword skip, and wrapper-command unpeel until the
  // head settles — each pass can open up the next. The loop is bounded by
  // `tokens.length` progressing monotonically.
  let progressed = true
  while (progressed && i < tokens.length) {
    progressed = false

    // env prefixes (FOO=bar, arr[0]=x)
    while (i < tokens.length && ENV_PREFIX_RE.test(tokens[i]!)) {
      i++
      progressed = true
    }

    // `function NAME` — swallow both the keyword and the function name,
    // THEN let the next pass handle the body's `{` as a BASH_KEYWORDS entry.
    if (tokens[i] === 'function') {
      i++
      if (i < tokens.length) i++ // drop the name
      progressed = true
    }

    // bash keywords at the head — one keyword per pass; special-cased
    // look-ahead for `case`, `for`, `select`.
    if (i < tokens.length && BASH_KEYWORDS.has(tokens[i]!)) {
      const kw = tokens[i]!
      i++
      progressed = true
      if (kw === 'for' || kw === 'select') {
        const doIdx = tokens.indexOf('do', i)
        if (doIdx !== -1) {
          i = doIdx + 1
        } else {
          // `for NAME in LIST;` was the whole statement (body lives in a
          // separate split statement) — nothing more to check here.
          i = tokens.length
        }
      } else if (kw === 'case') {
        const inIdx = tokens.indexOf('in', i)
        if (inIdx !== -1) {
          i = inIdx + 1
          // Skip the case-arm pattern token: `a)`, `(a)`, `*)`, `foo|bar)`.
          // Heuristic: the token contains a `)` or starts with `(`.
          if (
            i < tokens.length &&
            (tokens[i]!.includes(')') || tokens[i]!.startsWith('('))
          ) {
            i++
          }
        } else {
          i = tokens.length
        }
      }
    }

    // Wrapper commands (exec / env / nice / command / builtin / nohup / ionice)
    if (i < tokens.length && COMMAND_WRAPPERS.has(tokens[i]!)) {
      i++
      progressed = true
      // `env` may be followed by KEY=VAL pairs before the actual command.
      while (i < tokens.length && ENV_PREFIX_RE.test(tokens[i]!)) i++
    }
  }

  const cmdRaw = tokens[i]
  if (!cmdRaw) return
  const command = normalizeCommandHead(cmdRaw)
  out.push({ command, args: tokens.slice(i + 1) })
}

/**
 * Split a statement at top-level whitespace between balanced `(...)` or
 * `{...}` groups, so `(rm -rf /) (echo safe)` becomes two substatements. If
 * the statement contains no such split point, returns `[statement]`.
 */
function splitTopLevelGroups(statement: string): string[] {
  const out: string[] = []
  let buf = ''
  let paren = 0
  let brace = 0
  let quote: '"' | "'" | '`' | null = null
  const flush = () => {
    const t = buf.trim()
    if (t) out.push(t)
    buf = ''
  }
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i]!
    if (quote) {
      buf += c
      if (c === '\\' && quote === '"' && i + 1 < statement.length) {
        buf += statement[i + 1]!
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      buf += c
      continue
    }
    if (c === '\\' && i + 1 < statement.length) {
      buf += c + statement[i + 1]!
      i++
      continue
    }
    if (c === '(') paren++
    else if (c === ')') paren = Math.max(0, paren - 1)
    else if (c === '{') brace++
    else if (c === '}') brace = Math.max(0, brace - 1)
    // Only split on whitespace at true top level.
    if (paren === 0 && brace === 0 && /\s/.test(c) && buf.trim() !== '') {
      // Whitespace at depth 0 and the current buffer ends with a `)` or `}`:
      // this is a group-to-group transition → flush.
      if (buf.endsWith(')') || buf.endsWith('}')) {
        flush()
        continue
      }
    }
    buf += c
  }
  flush()
  return out
}

/** Peel a single layer of `(...)` or `{ ... }` if the statement is entirely wrapped. */
function unwrapGroup(statement: string): string {
  const s = statement.trim()
  if (s.length < 2) return statement
  const first = s[0]
  const last = s[s.length - 1]
  if (first === '(' && last === ')') {
    if (groupIsBalancedWrapper(s, '(', ')')) return s.slice(1, -1)
  } else if (first === '{' && last === '}') {
    // `{ ... }` in bash requires whitespace after `{` and `;` or newline before `}`.
    // We don't enforce that strictly here — just peel.
    if (groupIsBalancedWrapper(s, '{', '}')) {
      const inner = s.slice(1, -1).trim()
      // `{ cmd; }` often leaves a trailing `;` — normalize.
      return inner.endsWith(';') ? inner.slice(0, -1) : inner
    }
  }
  return statement
}

function groupIsBalancedWrapper(s: string, open: string, close: string): boolean {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length) {
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      i++
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      // If depth hits zero before the final char, this isn't a single wrapping group.
      if (depth === 0 && i !== s.length - 1) return false
    }
  }
  return depth === 0
}

function stripLineComment(line: string): string {
  let quote: '"' | "'" | '`' | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < line.length) {
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      i++
      continue
    }
    if (c === '#') {
      if (i === 0 || /\s/.test(line[i - 1]!)) return line.slice(0, i)
    }
  }
  return line
}

export function splitStatements(line: string): string[] {
  const result: string[] = []
  let buf = ''
  let quote: '"' | "'" | '`' | null = null
  let dollarParen = 0
  let parenDepth = 0
  let braceDepth = 0
  const flush = () => {
    const t = buf.trim()
    if (t) result.push(t)
    buf = ''
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      buf += c
      if (c === '\\' && quote === '"' && i + 1 < line.length) {
        buf += line[i + 1]!
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      buf += c
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      buf += c + line[i + 1]!
      i++
      continue
    }
    if (c === '$' && line[i + 1] === '(') {
      dollarParen++
      buf += '$('
      i++
      continue
    }
    if (c === ')' && dollarParen > 0) {
      dollarParen--
      buf += c
      continue
    }
    if (dollarParen > 0) {
      buf += c
      continue
    }
    // Track plain paren / brace depth so `;` inside `(a; b)` doesn't split us.
    if (c === '(') {
      parenDepth++
      buf += c
      continue
    }
    if (c === ')' && parenDepth > 0) {
      parenDepth--
      buf += c
      continue
    }
    if (c === '{') {
      braceDepth++
      buf += c
      continue
    }
    if (c === '}' && braceDepth > 0) {
      braceDepth--
      buf += c
      continue
    }
    if (parenDepth > 0 || braceDepth > 0) {
      buf += c
      continue
    }
    // `;;` is a case-arm terminator in bash — split on it BEFORE the generic
    // `;` rule so `case x in a) rm -rf /;; esac` yields the arm body as its
    // own statement.
    if (c === ';' && line[i + 1] === ';') {
      flush()
      i++
      continue
    }
    if (c === ';') {
      flush()
      continue
    }
    if (c === '&' && line[i + 1] === '&') {
      flush()
      i++
      continue
    }
    if (c === '|' && line[i + 1] === '|') {
      flush()
      i++
      continue
    }
    if (c === '|') {
      flush()
      continue
    }
    if (c === '&') {
      flush()
      continue
    }
    buf += c
  }
  flush()
  return result
}

export function tokenize(statement: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let inToken = false
  let quote: '"' | "'" | '`' | null = null
  const flush = () => {
    if (inToken) {
      tokens.push(buf)
      buf = ''
      inToken = false
    }
  }
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i]!
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < statement.length) {
        buf += statement[i + 1]!
        i++
        continue
      }
      if (c === quote) {
        quote = null
        continue
      }
      buf += c
      inToken = true
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      inToken = true
      continue
    }
    if (c === '\\' && i + 1 < statement.length) {
      buf += statement[i + 1]!
      inToken = true
      i++
      continue
    }
    if (/\s/.test(c)) {
      flush()
      continue
    }
    if (c === '>' || c === '<') {
      flush()
      let j = i
      while (
        j < statement.length &&
        (statement[j] === '>' || statement[j] === '<' || statement[j] === '&')
      )
        j++
      // If the next non-whitespace is `(` it's process substitution — let the
      // substitution extractor handle it; don't swallow as redirect target.
      let k = j
      while (k < statement.length && /\s/.test(statement[k]!)) k++
      if (statement[k] === '(') {
        i = j - 1
        continue
      }
      // Normal redirect — skip target token.
      j = k
      if (j < statement.length) {
        const openCh = statement[j]!
        if (openCh === "'" || openCh === '"' || openCh === '`') {
          j++
          while (j < statement.length && statement[j] !== openCh) {
            if (statement[j] === '\\' && openCh === '"' && j + 1 < statement.length) j++
            j++
          }
          if (j < statement.length) j++
        } else {
          while (j < statement.length && !/\s/.test(statement[j]!)) j++
        }
      }
      i = j - 1
      continue
    }
    buf += c
    inToken = true
  }
  flush()
  return tokens
}

/**
 * Extract text inside every $(...), `...`, <(...), >(...).
 * Caller recurses with `extractCommands` on each extracted body.
 */
export function extractSubstitutions(text: string): string[] {
  const out: string[] = []
  let quote: "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      continue
    }
    if (c === "'") {
      quote = "'"
      continue
    }
    if (c === '\\' && i + 1 < text.length) {
      i++
      continue
    }
    if (c === '$' && text[i + 1] === '(') {
      const end = findMatchingClose(text, i + 1, '(', ')')
      if (end > i + 1) {
        out.push(text.slice(i + 2, end))
        i = end
        continue
      }
    }
    if ((c === '<' || c === '>') && text[i + 1] === '(') {
      const end = findMatchingClose(text, i + 1, '(', ')')
      if (end > i + 1) {
        out.push(text.slice(i + 2, end))
        i = end
        continue
      }
    }
    if (c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\' && j + 1 < text.length) j++
        j++
      }
      out.push(text.slice(i + 1, j))
      i = j
      continue
    }
  }
  return out
}

function findMatchingClose(text: string, openIdx: number, open: string, close: string): number {
  let depth = 1
  let j = openIdx + 1
  while (j < text.length && depth > 0) {
    if (text[j] === '\\' && j + 1 < text.length) {
      j += 2
      continue
    }
    if (text[j] === open) depth++
    else if (text[j] === close) depth--
    if (depth > 0) j++
  }
  return j
}
