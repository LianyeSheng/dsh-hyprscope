/** Best-effort session lock detection through logind's LockedHint. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LockState } from './types.ts'

const run = promisify(execFile)

/** Executor signature accepted by {@link readLockState}; injectable for tests. */
export type SessionExec = (file: string, args: string[], options: {
  timeout: number
  encoding: 'utf8'
}) => Promise<{ stdout: string }>

/** One session row from `loginctl list-sessions`. */
export interface SessionRow {
  id: string
  seat: string
}

/**
 * Parse `loginctl show-session` properties.
 * @param text Standard output of `loginctl show-session`.
 * @returns Property map.
 */
export function parseSessionProperties(text: string): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    properties[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return properties
}

/**
 * Pick the compositor sessions owned by one user from `loginctl list-sessions` rows.
 * @param text `loginctl list-sessions --no-legend` output.
 * @param uid User id that owns the compositor.
 * @returns Candidate sessions with a hardware seat.
 */
export function parseSessionRows(text: string, uid: number): SessionRow[] {
  return text.split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [id = '', rowUid = '', , seat = ''] = line.trim().split(/\s+/)
      return { id, uid: Number.parseInt(rowUid, 10), seat }
    })
    .filter(row => row.uid === uid && row.seat !== '-')
    .map(({ id, seat }) => ({ id, seat }))
}

/**
 * Read lock state without trusting the absence of a signal.
 *
 * `ext-session-lock-v1` does not force a locker to set logind's `LockedHint`, so `locked`
 * is only ever `true` when the hint proves a lock; `null` means "no evidence".
 * @param options User to inspect, process timeout, and an injectable executor for tests.
 * @returns Lock observation.
 */
export async function readLockState(options: {
  uid?: number
  timeoutMs?: number
  exec?: SessionExec
} = {}): Promise<LockState> {
  const uid = options.uid ?? process.getuid?.()
  const exec: SessionExec = options.exec
    ?? (async (file, args, execOptions) => {
      const { stdout } = await run(file, args, execOptions)
      return { stdout }
    })
  const unavailable = (reason: string): LockState => ({
    locked: null, source: 'loginctl', sessionId: null, seat: null, type: null, reason,
  })
  if (uid === undefined) return unavailable('no-user-id')
  let rows: SessionRow[]
  try {
    const { stdout } = await exec('loginctl', ['list-sessions', '--no-legend', '--no-pager'],
      { timeout: options.timeoutMs ?? 3000, encoding: 'utf8' })
    rows = parseSessionRows(stdout, uid)
  } catch {
    return { ...unavailable('loginctl-unavailable'), source: 'unavailable' }
  }
  if (rows.length === 0) return unavailable('no-session')
  const described: Array<Record<string, string> & { id: string; seat: string }> = []
  for (const row of rows) {
    try {
      const { stdout } = await exec('loginctl', ['show-session', row.id, '--no-pager',
        '-p', 'Type', '-p', 'Active', '-p', 'LockedHint'], { timeout: options.timeoutMs ?? 3000, encoding: 'utf8' })
      described.push({ id: row.id, seat: row.seat, ...parseSessionProperties(stdout) })
    } catch {
      return unavailable('session-query-failed')
    }
  }
  const active = described.filter(session => session.Type === 'wayland' && session.Active === 'yes')
  if (active.length !== 1) {
    return unavailable(active.length === 0 ? 'no-active-wayland-session' : 'ambiguous-wayland-session')
  }
  const session = active[0]!
  return {
    locked: session.LockedHint === 'yes' ? true : null,
    source: 'loginctl',
    sessionId: session.id,
    seat: session.seat,
    type: session.Type ?? null,
    ...(session.LockedHint === 'no' ? { reason: 'locked-hint-negative-only' } : {}),
  }
}
