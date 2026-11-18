/** Doctor environment checks: overlay lookup, state directory probe, window-capture semantics. */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CAPTURE_WINDOW_SEMANTICS, doctorLimitations, inspectStateDirectory, renderEnvironmentSummary,
  resolveOverlayRuntime, stateDirectoryPath,
} from '../src/cli.ts'
import type { DoctorEnvironment } from '../src/types.ts'
import { removeDir, tempDir, writeScript } from './support.ts'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

/** Build a PATH-only environment that sees no system binaries. */
function pathEnv(...directories: string[]): NodeJS.ProcessEnv {
  return { PATH: directories.join(':') }
}

test('resolveOverlayRuntime finds quickshell on PATH without running it', (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const binary = writeScript(directory, 'quickshell', '#!/bin/sh\nexit 1\n')
  const overlay = resolveOverlayRuntime(pathEnv(directory))
  assert.deepEqual(overlay, { binary: 'quickshell', path: binary, available: true, source: 'default', hint: null })
})

test('resolveOverlayRuntime honours HYPRSCOPE_QUICKSHELL and absolute paths', (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const qs = writeScript(directory, 'qs', '#!/bin/sh\nexit 0\n')
  const byName = resolveOverlayRuntime({ ...pathEnv(directory), HYPRSCOPE_QUICKSHELL: 'qs' })
  assert.deepEqual(byName, { binary: 'qs', path: qs, available: true, source: 'environment', hint: null })
  const byPath = resolveOverlayRuntime({ ...pathEnv(), HYPRSCOPE_QUICKSHELL: qs })
  assert.equal(byPath.available, true)
  assert.equal(byPath.path, qs)
})

test('resolveOverlayRuntime reports a missing binary with a fix', (t) => {
  const empty = tempDir()
  const withQs = tempDir()
  t.after(() => { removeDir(empty); removeDir(withQs) })
  const missing = resolveOverlayRuntime(pathEnv(empty))
  assert.equal(missing.available, false)
  assert.equal(missing.path, null)
  assert.match(missing.hint ?? '', /install quickshell/)
  writeScript(withQs, 'qs', '#!/bin/sh\nexit 0\n')
  const hint = resolveOverlayRuntime(pathEnv(withQs))
  assert.equal(hint.available, false)
  assert.match(hint.hint ?? '', /HYPRSCOPE_QUICKSHELL=qs/)
})

test('resolveOverlayRuntime ignores a non-executable file', (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  writeFileSync(join(directory, 'quickshell'), '#!/bin/sh\n')
  chmodSync(join(directory, 'quickshell'), 0o644)
  assert.equal(resolveOverlayRuntime(pathEnv(directory)).available, false)
})

test('stateDirectoryPath resolves XDG_STATE_HOME and the HOME default', () => {
  assert.equal(stateDirectoryPath({ XDG_STATE_HOME: '/state' }), '/state/hyprscope')
  assert.equal(stateDirectoryPath({ HOME: '/home/user' }), '/home/user/.local/state/hyprscope')
})

test('inspectStateDirectory reports an existing writable directory and writes nothing', async (t) => {
  const root = tempDir()
  t.after(() => removeDir(root))
  mkdirSync(join(root, 'hyprscope'))
  writeFileSync(join(root, 'hyprscope', 'baseline.json'), '{}')
  const before = readdirSync(root, { recursive: true })
  const state = await inspectStateDirectory({ XDG_STATE_HOME: root })
  assert.equal(state.path, join(root, 'hyprscope'))
  assert.equal(state.exists, true)
  assert.equal(state.writable, true)
  assert.equal(state.probe, join(root, 'hyprscope'))
  assert.equal(state.reason, null)
  assert.deepEqual(readdirSync(root, { recursive: true }), before)
})

test('inspectStateDirectory probes the nearest existing ancestor of a missing directory', async (t) => {
  const root = tempDir()
  t.after(() => removeDir(root))
  const state = await inspectStateDirectory({ XDG_STATE_HOME: join(root, 'missing', 'deeper') })
  assert.equal(state.exists, false)
  assert.equal(state.writable, true)
  assert.equal(state.probe, root)
  assert.equal(state.reason, null)
  assert.equal(readdirSync(root).length, 0, 'the probe must not create the state directory')
})

test('inspectStateDirectory reports an unwritable directory', { skip: isRoot ? 'running as root ignores mode bits' : false }, async (t) => {
  const root = tempDir()
  t.after(() => { chmodSync(root, 0o755); removeDir(root) })
  mkdirSync(join(root, 'hyprscope'))
  chmodSync(join(root, 'hyprscope'), 0o500)
  const state = await inspectStateDirectory({ XDG_STATE_HOME: root })
  assert.equal(state.exists, true)
  assert.equal(state.writable, false)
  assert.match(state.reason ?? '', /not writable/)
})

test('inspectStateDirectory reports a file occupying the state path', async (t) => {
  const root = tempDir()
  t.after(() => removeDir(root))
  writeFileSync(join(root, 'hyprscope'), 'not a directory')
  const state = await inspectStateDirectory({ XDG_STATE_HOME: root })
  assert.equal(state.exists, false)
  assert.equal(state.writable, false)
  assert.match(state.reason ?? '', /not a directory/)
})

test('doctorLimitations states the off-screen window-capture semantics', () => {
  const limitations = doctorLimitations()
  const line = limitations.find(entry => entry.startsWith('capture.window:'))
  assert.ok(line !== undefined)
  assert.match(line!, /inactive workspace/)
  assert.match(line!, /off-screen/)
  assert.match(CAPTURE_WINDOW_SEMANTICS, /inactive workspace or off-screen/)
  assert.equal(limitations.length, 4)
})

test('renderEnvironmentSummary names the overlay and state facts', () => {
  const environment: DoctorEnvironment = {
    overlay: { binary: 'quickshell', path: '/usr/bin/quickshell', available: true, source: 'default', hint: null },
    state: {
      path: '/home/user/.local/state/hyprscope', exists: true, writable: true,
      probe: '/home/user/.local/state/hyprscope', reason: null,
    },
    capture: { window: CAPTURE_WINDOW_SEMANTICS },
  }
  const text = renderEnvironmentSummary(environment)
  assert.match(text, /^environment$/m)
  assert.match(text, /overlay runtime {2}quickshell at \/usr\/bin\/quickshell \(default\)/)
  assert.match(text, /state directory {2}\/home\/user\/\.local\/state\/hyprscope \(exists, writable\)/)
  const missing = renderEnvironmentSummary({
    ...environment,
    overlay: { ...environment.overlay, available: false, path: null, hint: 'install quickshell' },
    state: { ...environment.state, writable: false, reason: 'the state directory is not writable' },
  })
  assert.match(missing, /not found on PATH/)
  assert.match(missing, /overlay hint +install quickshell/)
  assert.match(missing, /state hint +the state directory is not writable/)
})
