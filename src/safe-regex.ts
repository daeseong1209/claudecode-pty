import safeRegex from 'safe-regex2'

export interface CompiledPattern {
  regex: RegExp
  source: string
  ignoreCase: boolean
}

/**
 * Compile and validate a user-supplied regex pattern.
 *
 * Rejects:
 *   - Patterns longer than 2048 characters (heuristic against junk input).
 *   - Patterns flagged by safe-regex2 as at risk of catastrophic backtracking.
 *   - Patterns that fail to compile.
 *
 * Returns a pattern with the `g` flag stripped so stateful `test`/`exec` bleed
 * across lines can't happen downstream.
 */
export function compileSafePattern(pattern: string, ignoreCase = false): CompiledPattern {
  if (typeof pattern !== 'string') {
    throw new Error(`Pattern must be a string (got ${typeof pattern}).`)
  }
  if (pattern.length === 0) {
    throw new Error('Pattern must not be empty.')
  }
  if (pattern.length > 2048) {
    throw new Error('Pattern too long (max 2048 characters).')
  }

  // Try compile first so "invalid regex" errors surface with the right message
  // (safe-regex2 also returns false on unparseable input, so if we checked it
  // first, every syntax error would be reported as "unsafe").
  let regex: RegExp
  try {
    regex = new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid regex pattern '${pattern}': ${message}`)
  }

  if (!safeRegex(pattern)) {
    throw new Error(
      `Pattern '${pattern}' is flagged as unsafe (potential catastrophic backtracking). Rewrite with possessive quantifiers, anchored alternation, or smaller star height.`
    )
  }

  return { regex, source: pattern, ignoreCase }
}
