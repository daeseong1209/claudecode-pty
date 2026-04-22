import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AppConfig {
  allow: string[]
  deny: string[]
  defaultAction: 'allow' | 'deny'
  maxConcurrentSessions: number
  ringBufferBytes: number
}

const DEFAULT_CONFIG: AppConfig = {
  allow: [],
  deny: [],
  defaultAction: 'allow',
  maxConcurrentSessions: 32,
  ringBufferBytes: 1_000_000,
}

/**
 * Load config from ~/<configDirName>/config.json.
 *
 * Fail-open vs fail-closed:
 *   - File missing → DEFAULT_CONFIG (fail-open is fine; user hasn't opted in).
 *   - File present but unparseable / invalid shape → return DEFAULT_CONFIG and
 *     **log a prominent warning to stderr**. A silent fallback to "allow all"
 *     is a common source of lockdown-config typos; we refuse to be quiet when
 *     a user clearly tried to write a policy.
 */
export function loadConfig(configDirName: string): AppConfig {
  const path = join(homedir(), configDirName, 'config.json')
  if (!existsSync(path)) return DEFAULT_CONFIG

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    logConfigError(path, `unreadable: ${err instanceof Error ? err.message : String(err)}`)
    return DEFAULT_CONFIG
  }

  let parsed: Partial<AppConfig>
  try {
    parsed = JSON.parse(raw) as Partial<AppConfig>
  } catch (err) {
    logConfigError(
      path,
      `not valid JSON (${err instanceof Error ? err.message : String(err)}) — falling back to defaultAction=allow`
    )
    return DEFAULT_CONFIG
  }

  return {
    allow: Array.isArray(parsed.allow) ? parsed.allow.map(String) : DEFAULT_CONFIG.allow,
    deny: Array.isArray(parsed.deny) ? parsed.deny.map(String) : DEFAULT_CONFIG.deny,
    defaultAction:
      parsed.defaultAction === 'allow' || parsed.defaultAction === 'deny'
        ? parsed.defaultAction
        : DEFAULT_CONFIG.defaultAction,
    maxConcurrentSessions:
      typeof parsed.maxConcurrentSessions === 'number' && parsed.maxConcurrentSessions > 0
        ? Math.floor(parsed.maxConcurrentSessions)
        : DEFAULT_CONFIG.maxConcurrentSessions,
    ringBufferBytes:
      typeof parsed.ringBufferBytes === 'number' && parsed.ringBufferBytes > 1024
        ? Math.floor(parsed.ringBufferBytes)
        : DEFAULT_CONFIG.ringBufferBytes,
  }
}

function logConfigError(path: string, reason: string): void {
  // stderr is safe in MCP stdio transport (only stdout is the JSON-RPC channel).
  // eslint-disable-next-line no-console
  console.error(`[claudecode-pty] WARNING: config file at ${path} ${reason}`)
}
