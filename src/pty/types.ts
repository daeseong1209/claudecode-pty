import type { IPty } from 'node-pty'

export type PTYStatus = 'running' | 'exited' | 'killing' | 'killed'

export interface PTYSessionInternal {
  id: string
  title: string
  description: string
  command: string
  args: string[]
  workdir: string
  env?: Record<string, string>
  cols: number
  rows: number
  status: PTYStatus
  exitCode: number | null
  exitSignal: number | string | undefined
  pid: number
  createdAt: Date
  notifyOnExit: boolean
  timeoutSeconds?: number
  timedOut: boolean
  process: IPty | null
}

export interface PTYSessionInfo {
  id: string
  title: string
  description: string
  command: string
  args: string[]
  workdir: string
  cols: number
  rows: number
  status: PTYStatus
  notifyOnExit: boolean
  timeoutSeconds?: number
  timedOut: boolean
  exitCode: number | null
  exitSignal?: number | string
  pid: number
  createdAt: string
  lineCount: number
  byteLength: number
  droppedLines: number
  droppedBytes: number
}

export interface SpawnOptions {
  command: string
  args?: string[]
  workdir?: string
  env?: Record<string, string>
  title?: string
  description: string
  cols?: number
  rows?: number
  notifyOnExit?: boolean
  timeoutSeconds?: number
}

export interface ReadOptions {
  offset?: number
  limit?: number
  tail?: number
  pattern?: string
  ignoreCase?: boolean
  contextBefore?: number
  contextAfter?: number
}

export interface ReadResult {
  lines: Array<{ lineNumber: number; text: string }>
  totalLines: number
  offset: number
  hasMore: boolean
  droppedLines: number
  droppedBytes: number
  pattern?: string
  matchCount?: number
}
