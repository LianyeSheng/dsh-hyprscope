/** Integration against the live compositor; skipped when no session is reachable. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.ts'
import { waitForEvent } from '../src/events.ts'
import { hyprctlJson } from '../src/hyprctl.ts'
import { capture } from '../src/screenshot.ts'
import { captureToplevel, defaultCaptureBinary } from '../src/toplevel.ts'
import { discoverSession } from '../src/session.ts'
import { readState } from '../src/state.ts'
import type { RawVersion, Session } from '../src/types.ts'
import { probeWaylandGlobals } from '../src/wayland.ts'
import { removeDir, sink, tempDir } from './support.ts'

const session: Session | null = (() => {
  try {
    return discoverSession()
  } catch {
    return null
  }
})()
const skip = session === null ? 'no reachable Hyprland session' : false

test('live: hyprctl reports a version', { skip }, async () => {
  const version = await hyprctlJson<RawVersion>(session!, 'version')
  assert.match(version!.version!, /^\d+\.\d+/)
  assert.equal(typeof version!.branch, 'string')
})

test('live: state contains monitors, workspaces, clients, and a cursor', { skip }, async () => {
  const state = await readState(session!)
  assert.equal(state.readOnly, true)
  assert.ok(Array.isArray(state.clients))
  assert.ok(Array.isArray(state.workspaces))
  assert.ok(state.monitors.length >= 1)
  for (const monitor of state.monitors) {
    assert.ok(monitor.size.width > 0 && monitor.size.height > 0)
  }
  assert.equal(typeof state.cursor?.x, 'number')
  assert.equal(typeof state.cursor?.y, 'number')
  assert.ok(state.lock.source === 'loginctl' || state.lock.source === 'unavailable')
})

test('live: capture writes a PNG of the layout', { skip }, async (t) => {
  const directory = tempDir('hyprscope-live-')
  t.after(() => removeDir(directory))
  const result = await capture(session!, { output: join(directory, 'live.png') })
  assert.ok(result.width > 0 && result.height > 0)
  assert.ok(result.bytes > result.width && result.sha256.length === 64)
  assert.equal(result.source.scope, 'layout')
})

test('live: capture a window even when it is not on the active workspace', { skip }, async (t) => {
  if (!existsSync(defaultCaptureBinary())) {
    t.skip('bin/wl-capture is not built (pnpm run build:capture)')
    return
  }
  const directory = tempDir('hyprscope-live-')
  t.after(() => removeDir(directory))
  const state = await readState(session!)
  const active = state.active.workspace?.name ?? null
  const candidates = state.clients.filter(client => client.mapped
    && typeof client.stableId === 'string' && client.stableId !== '')
  if (candidates.length === 0) {
    t.skip('no mapped window to capture')
    return
  }
  const hidden = candidates.find(client => active !== null && client.workspace?.name !== active)
  const target = hidden ?? candidates[0]!
  const result = await captureToplevel(session!, {
    output: join(directory, 'window.png'), identifier: target.stableId!,
  })
  assert.equal(result.source.scope, 'window')
  assert.equal(result.source.window?.identifier, target.stableId)
  assert.ok(result.width > 0 && result.height > 0)
  assert.ok(result.bytes > result.width && result.sha256.length === 64)
})

test('live: event wait times out with TIMEOUT', { skip }, async () => {
  await assert.rejects(waitForEvent(session!, () => false, { timeoutMs: 250 }),
    (error: Error & { code?: string }) => error.code === 'TIMEOUT')
})

test('live: the Wayland probe reports one seat and injection protocols', { skip }, async () => {
  const probe = await probeWaylandGlobals(session!)
  assert.equal(probe.seatCount, 1)
  assert.equal(probe.capabilities.virtualKeyboard, true)
  assert.equal(probe.capabilities.virtualPointer, true)
})

test('live: CLI state --json round-trips through stdout', { skip }, async () => {
  const stdout = sink()
  const code = await main(['state', '--json'], { stdout, stderr: sink() })
  assert.equal(code, 0)
  const state = JSON.parse(stdout.text) as { readOnly: boolean; monitors: unknown[] }
  assert.equal(state.readOnly, true)
  assert.ok(Array.isArray(state.monitors))
})
