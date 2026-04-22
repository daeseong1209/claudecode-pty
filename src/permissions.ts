import type { AppConfig } from './config.js'
import { normalizeCommandHead } from './shell-parse.js'

/**
 * Token-level glob matcher: `*` is zero-or-more chars within a token, `?` is
 * exactly one character. Anchored (full-string match).
 */
function globMatch(str: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') +
      '$',
    's'
  )
  return regex.test(str)
}

/**
 * Positional structured match of a command line against a pattern.
 *
 * Grammar (tokens separated by whitespace):
 *   - First token matches the command head (basename-normalized).
 *   - Each subsequent token matches exactly one argument positionally.
 *   - A token `*` glob-matches exactly one argument (any single token).
 *   - A token `**` is a variadic marker — matches zero or more arguments. It
 *     may appear at most once per pattern.
 *   - A pattern consisting solely of `**` is normalized to "any command with
 *     any args" — equivalent to `* **`.
 */
function structuredMatch(command: string, args: string[], pattern: string): boolean {
  const tokens = pattern.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  // Special case: a pattern of just `**` means "anything".
  if (tokens.length === 1 && tokens[0] === '**') return true
  const [head, ...rest] = tokens
  if (!head || !globMatch(command, head)) return false
  return positionalMatch(args, rest)
}

function positionalMatch(items: string[], patterns: string[]): boolean {
  const starStarCount = patterns.filter((p) => p === '**').length
  if (starStarCount === 0) {
    if (items.length !== patterns.length) return false
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i]!
      const a = items[i]
      if (a === undefined || !globMatch(a, p)) return false
    }
    return true
  }
  if (starStarCount > 1) {
    return false
  }
  const idx = patterns.indexOf('**')
  const prefix = patterns.slice(0, idx)
  const suffix = patterns.slice(idx + 1)
  if (items.length < prefix.length + suffix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    const a = items[i]
    const p = prefix[i]!
    if (a === undefined || !globMatch(a, p)) return false
  }
  const suffixStart = items.length - suffix.length
  for (let i = 0; i < suffix.length; i++) {
    const a = items[suffixStart + i]
    const p = suffix[i]!
    if (a === undefined || !globMatch(a, p)) return false
  }
  return true
}

export type PermissionDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }

/**
 * Check command against configured allow/deny lists. Deny wins over allow.
 * If neither matches, fall back to `defaultAction`.
 *
 * The command head is normalized via `normalizeCommandHead` before matching,
 * so `/bin/rm` and `rm` both match a rule keyed on `rm`.
 */
export function checkPermission(
  config: AppConfig,
  command: string,
  args: string[]
): PermissionDecision {
  const normalized = normalizeCommandHead(command)
  for (const pattern of config.deny) {
    if (structuredMatch(normalized, args, pattern)) {
      return {
        action: 'deny',
        reason: `command '${command} ${args.join(' ')}' matches deny rule '${pattern}'`,
      }
    }
  }
  for (const pattern of config.allow) {
    if (structuredMatch(normalized, args, pattern)) {
      return { action: 'allow' }
    }
  }
  if (config.defaultAction === 'deny') {
    return {
      action: 'deny',
      reason: `command '${command} ${args.join(' ')}' does not match any allow rule (defaultAction=deny)`,
    }
  }
  return { action: 'allow' }
}
