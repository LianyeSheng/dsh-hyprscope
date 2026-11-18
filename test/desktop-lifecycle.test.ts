/** Lifecycle of the nested desktop, exercised with a fake compositor and no real Hyprland. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { attachDesktop, startDesktop, statusDesktop, stopDesktop } from '../src/desktop/lifecycle.ts'
import { desktopPaths, readDesktopRecord } from '../src/desktop/record.ts'
import { processAlive } from '../src/lease/state.ts'
import { closeServer, fakeInstance, listenUnix, removeDir, writeScript } from './support.ts'

/** Fake compositor: instance sockets, a Wayland socket, a lock file, and SIGTERM exit. */
const FAKE_HYPRLAND = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const runtime = process.env.XDG_RUNTIME_DIR
if (!runtime) {
  process.stderr.write('XDG_RUNTIME_DIR is required' + String.fromCharCode(10))
  process.exit(2)
}
const signature = 'x'.repeat(61)
const instanceDir = join(runtime, 'hypr', signature)
mkdirSync(instanceDir, { recursive: true })
const servers = []
for (const name of ['.socket.sock', '.socket2.sock', 'wayland-1']) {
  const path = name === 'wayland-1' ? join(runtime, name) : join(instanceDir, name)
  const server = createServer(socket => socket.end())
  server.listen(path)
  servers.push(server)
}
writeFileSync(join(instanceDir, 'hyprland.lock'),
  process.pid + String.fromCharCode(10) + 'wayland-1' + String.fromCharCode(10))
const stop = () => {
  for (const server of servers) server.close()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {}, 1000)
`

const SCRIPT_DIR = mkdtempSync(join('/tmp', 'hs-bin-'))
const FAKE_HYPRLAND_PATH = writeScript(SCRIPT_DIR, 'fake-hyprland.mjs', FAKE_HYPRLAND)

after(() => { removeDir(SCRIPT_DIR) })

/** One test's isolated host session, state directory, and desktop runtime root. */
interface Fixture {
  root: string
  stateHome: string
  hostRuntime: string
  hostSignature: string
  runtimeRoot: string
  env: NodeJS.ProcessEnv
}

/** @param milliseconds Delay. @returns Completion after the delay. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => { setTimeout(resolvePromise, milliseconds) })
}

/**
 * Wait for a pid to disappear.
 * @param pid Process id.
 * @param timeoutMs Maximum wait.
 */
async function waitDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await sleep(50)
  }
  assert.equal(processAlive(pid), false, 'process ' + String(pid) + ' should be gone')
}

/** @param pid Process id to kill without ceremony. */
function killHard(pid: number): void {
  try { process.kill(pid, 'SIGKILL') } catch {
    // Already gone.
  }
}

/**
 * Kill a recorded agent desktop left behind by a failed assertion.
 * @param env Environment that owns the record.
 */
async function reapRecordedDesktop(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const { record } = await readDesktopRecord(env)
    if (record?.target === 'agent' && record.pid !== null) killHard(record.pid)
  } catch {
    // A record that cannot be read has no process to reap.
  }
}

/**
 * Build a host session with a live Wayland socket and an isolated state root.
 * @param t Test context; teardown is registered here.
 * @returns Fixture.
 */
async function fixture(t: TestContext): Promise<Fixture> {
  const root = mkdtempSync(join('/tmp', 'hs-'))
  const stateHome = mkdtempSync(join(tmpdir(), 'hs-state-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const hostRuntime = join(root, 'host')
  mkdirSync(hostRuntime, { recursive: true })
  const hostSignature = 'host-instance'
  const host = await fakeInstance(hostRuntime, hostSignature, { pid: process.pid, display: 'wayland-1' })
  const servers: Server[] = [...host.servers, await listenUnix(join(hostRuntime, 'wayland-1'))]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_RUNTIME_DIR: hostRuntime,
    XDG_STATE_HOME: stateHome,
    HYPRSCOPE_DESKTOP_RUNTIME_DIR: join(root, 'rt'),
    HYPRSCOPE_HYPRLAND: FAKE_HYPRLAND_PATH,
  }
  for (const key of ['HYPRLAND_INSTANCE_SIGNATURE', 'HYPRSCOPE_SIGNATURE', 'HYPRSCOPE_WAYLAND_DISPLAY', 'HYPRSCOPE_RUNTIME_DIR', 'WAYLAND_DISPLAY']) delete env[key]
  t.after(async () => {
    await reapRecordedDesktop(env)
    for (const server of servers) await closeServer(server)
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  })
  return { root, stateHome, hostRuntime, hostSignature, runtimeRoot: join(root, 'rt'), env }
}

/**
 * Assert that a promise fails with a coded HyprscopeError.
 * @param promise Operation under test.
 * @param code Expected error code.
 * @param pattern Optional message pattern.
 */
async function rejectsWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as { code?: string }).code, code)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

test('status reports absent without a record', async (t) => {
  const f = await fixture(t)
  const report = await statusDesktop(f.env)
  assert.equal(report.state, 'absent')
  assert.equal(report.target, null)
  assert.equal(report.record, null)
  assert.equal(report.runtimeDir, null)
  assert.equal(report.signature, null)
  assert.equal(report.pid, null)
  assert.equal(report.waylandDisplay, null)
  assert.equal(report.configHash, null)
  assert.deepEqual(report.checks, {
    pid: false, instance: false, controlSocket: false, waylandSocket: false, configHash: false,
  })
  assert.deepEqual(report.baseline, {
    file: join(f.stateHome, 'hyprscope', 'baseline.json'), present: false, state: null,
  })
  assert.equal(report.detail, null)
})

test('stop reports absent without a record', async (t) => {
  const f = await fixture(t)
  const stopped = await stopDesktop({ env: f.env })
  assert.equal(stopped.state, 'absent')
  assert.equal(stopped.signature, null)
  assert.equal(stopped.runtimeDir, f.runtimeRoot)
  assert.equal(stopped.removed, false)
  assert.equal(stopped.detail, null)
})

test('start writes the generated config, record, and pid, and reports running', async (t) => {
  const f = await fixture(t)
  const report = await startDesktop({ env: f.env, size: '1280x800' })
  t.after(async () => { await stopDesktop({ env: f.env }) })
  const pid = report.pid
  assert.ok(pid !== null && pid > 0)
  assert.equal(report.state, 'running')
  assert.equal(report.target, 'agent')
  assert.equal(report.signature, 'x'.repeat(61))
  assert.equal(report.runtimeDir, f.runtimeRoot)
  assert.equal(report.waylandDisplay, 'wayland-1')
  assert.ok(report.configHash !== null && /^[0-9a-f]{64}$/.test(report.configHash))
  assert.deepEqual(report.checks, {
    pid: true, instance: true, controlSocket: true, waylandSocket: true, configHash: true,
  })
  assert.equal(report.detail, null)
  assert.ok(processAlive(pid))
  assert.equal(statSync(f.runtimeRoot).mode & 0o777, 0o700)

  const paths = desktopPaths(f.env)
  const configFile = join(paths.configDir, 'hypr', 'hyprland.lua')
  assert.ok(existsSync(configFile))
  assert.ok(readFileSync(configFile, 'utf8').startsWith('-- generated by hyprscope control desktop'))
  assert.equal(readFileSync(paths.pidFile, 'utf8').trim(), String(pid))

  const { record } = await readDesktopRecord(f.env)
  assert.ok(record)
  assert.deepEqual(report.record, record)
  assert.equal(record.schema, 1)
  assert.equal(record.state, 'running')
  assert.equal(record.target, 'agent')
  assert.equal(record.runtimeDir, f.runtimeRoot)
  assert.equal(record.pid, pid)
  assert.equal(record.configDir, paths.configDir)
  assert.equal(record.configHash, report.configHash)
  assert.equal(record.size, '1280x800')
  assert.equal(record.consent.source, 'chat')
  assert.equal(record.consent.note, 'Started an agent desktop (nested Hyprland) for this agent.')
  assert.equal(record.createdAt, record.updatedAt)
  assert.equal(record.detail, null)
  assert.equal(report.baseline.present, false)
  assert.ok(report.baseline.file.endsWith(record.signature + '.json'))
})

test('status after the compositor is killed reports stale, then closed once its sockets are gone', async (t) => {
  const f = await fixture(t)
  const started = await startDesktop({ env: f.env })
  const pid = started.pid
  assert.ok(pid !== null)
  killHard(pid)
  await waitDead(pid)

  const stale = await statusDesktop(f.env)
  assert.equal(stale.state, 'stale')
  assert.equal(stale.checks.pid, false)
  assert.ok(stale.detail !== null && stale.detail.includes(String(pid)))
  const { record } = await readDesktopRecord(f.env)
  assert.equal(record?.state, 'running')

  rmSync(f.runtimeRoot, { recursive: true, force: true })
  const closed = await statusDesktop(f.env)
  assert.equal(closed.state, 'closed')
  assert.deepEqual(closed.checks, {
    pid: false, instance: false, controlSocket: false, waylandSocket: false, configHash: true,
  })
  assert.ok(closed.detail !== null)
})

test('status notices a changed generated configuration and stays read-only', async (t) => {
  const f = await fixture(t)
  await startDesktop({ env: f.env })
  t.after(async () => { await stopDesktop({ env: f.env }) })
  const paths = desktopPaths(f.env)
  const snippet = join(paths.snippetsDir, 'extra.lua')
  mkdirSync(dirname(snippet), { recursive: true })
  writeFileSync(snippet, '-- agent change' + String.fromCharCode(10))

  const report = await statusDesktop(f.env)
  assert.equal(report.state, 'stale')
  assert.equal(report.checks.configHash, false)
  assert.ok(report.detail !== null && report.detail.includes('configuration'))
  const { record } = await readDesktopRecord(f.env)
  assert.equal(record?.state, 'running')
})

test('start cleans a stale record before spawning a new desktop', async (t) => {
  const f = await fixture(t)
  const first = await startDesktop({ env: f.env })
  const firstPid = first.pid
  assert.ok(firstPid !== null)
  killHard(firstPid)
  await waitDead(firstPid)
  assert.equal((await statusDesktop(f.env)).state, 'stale')

  const second = await startDesktop({ env: f.env })
  t.after(async () => { await stopDesktop({ env: f.env }) })
  assert.equal(second.state, 'running')
  const secondPid = second.pid
  assert.ok(secondPid !== null)
  assert.notEqual(secondPid, firstPid)
  assert.ok(processAlive(secondPid))
  assert.equal(second.signature, 'x'.repeat(61))
})

test('start refuses a desktop that is already running', async (t) => {
  const f = await fixture(t)
  await startDesktop({ env: f.env })
  t.after(async () => { await stopDesktop({ env: f.env }) })
  await rejectsWith(startDesktop({ env: f.env }), 'DESKTOP_FAILED', /already running/)
  assert.equal((await statusDesktop(f.env)).state, 'running')
})

test('start rejects an invalid size with USAGE before creating the runtime root', async (t) => {
  const f = await fixture(t)
  await rejectsWith(startDesktop({ env: f.env, size: 'huge' }), 'USAGE', /not valid/)
  assert.equal(existsSync(f.runtimeRoot), false)
})

test('start refuses a runtime root too long for unix sockets before spawning', async (t) => {
  const f = await fixture(t)
  const longRoot = join(f.root, 'x'.repeat(40))
  const env = { ...f.env, HYPRSCOPE_DESKTOP_RUNTIME_DIR: longRoot }
  await rejectsWith(startDesktop({ env }), 'DESKTOP_FAILED', /too long/)
  assert.equal(existsSync(longRoot), false)
  assert.equal(existsSync(join(longRoot, 'hypr')), false)
})

test('start cleans up when the compositor binary cannot be spawned', async (t) => {
  const f = await fixture(t)
  const env = { ...f.env, HYPRSCOPE_HYPRLAND: join(f.root, 'missing-hyprland') }
  await rejectsWith(startDesktop({ env }), 'DESKTOP_FAILED', /produced no process id/)
  assert.equal(existsSync(f.runtimeRoot), false)
  const { record } = await readDesktopRecord(env)
  assert.equal(record, null)
})

test('stop terminates the desktop, removes the runtime root, and keeps a closed record', async (t) => {
  const f = await fixture(t)
  const started = await startDesktop({ env: f.env })
  const pid = started.pid
  assert.ok(pid !== null)
  const stopped = await stopDesktop({ env: f.env })
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.signature, started.signature)
  assert.equal(stopped.runtimeDir, f.runtimeRoot)
  assert.equal(stopped.removed, true)
  assert.equal(stopped.detail, null)
  assert.equal(existsSync(f.runtimeRoot), false)
  await waitDead(pid)

  const { record } = await readDesktopRecord(f.env)
  assert.ok(record)
  assert.equal(record.state, 'closed')
  assert.equal(record.pid, pid)
  assert.equal(record.detail, 'stopped by hyprscope control desktop stop')

  const after = await statusDesktop(f.env)
  assert.equal(after.state, 'closed')
  assert.equal(after.checks.pid, false)
  assert.equal(after.checks.instance, false)
  assert.equal(after.checks.controlSocket, false)
  assert.equal(after.checks.waylandSocket, false)
})

test('stop on an external desktop only forgets the record', async (t) => {
  const f = await fixture(t)
  const external = join(f.root, 'external')
  mkdirSync(external, { recursive: true })
  const instance = await fakeInstance(external, 'external-instance', { pid: process.pid, display: 'wayland-3' })
  const wayland = await listenUnix(join(external, 'wayland-3'))
  t.after(async () => {
    for (const server of [...instance.servers, wayland]) await closeServer(server)
  })
  const attached = await attachDesktop({ runtimeDir: external, signature: 'external-instance', env: f.env })
  assert.equal(attached.state, 'running')

  const stopped = await stopDesktop({ env: f.env })
  assert.equal(stopped.state, 'forgotten')
  assert.equal(stopped.signature, 'external-instance')
  assert.equal(stopped.runtimeDir, external)
  assert.equal(stopped.removed, false)
  assert.ok(existsSync(external))
  assert.ok(existsSync(join(instance.dir, '.socket.sock')))
  const { record } = await readDesktopRecord(f.env)
  assert.equal(record, null)
})

test('attach rejects the signature of the user desktop', async (t) => {
  const f = await fixture(t)
  await rejectsWith(
    attachDesktop({ runtimeDir: f.hostRuntime, signature: f.hostSignature, env: f.env }),
    'USAGE',
    /user's own desktop/,
  )
})

test('start refuses a host whose configuration provider is not Lua', async (t) => {
  const f = await fixture(t)
  delete f.env.HYPRSCOPE_HYPRLAND
  const dir = mkdtempSync(join('/tmp', 'hs-hyprctl-'))
  t.after(() => { removeDir(dir) })
  const hyprctl = writeScript(dir, 'fake-hyprctl', '#!/bin/sh\nprintf \'%s\\n\' \'{"configProvider":"hyprlang"}\'\n')
  const previous = process.env.HYPRSCOPE_HYRPRCTL
  process.env.HYPRSCOPE_HYRPRCTL = hyprctl
  try {
    await rejectsWith(startDesktop({ env: f.env, timeoutMs: 2_000 }), 'DESKTOP_FAILED', /hyprlang/)
  } finally {
    if (previous === undefined) delete process.env.HYPRSCOPE_HYRPRCTL
    else process.env.HYPRSCOPE_HYRPRCTL = previous
  }
  const { record } = await readDesktopRecord(f.env)
  assert.equal(record, null)
  assert.equal(existsSync(desktopPaths(f.env).runtimeRoot), false)
})

test('attach accepts an external instance without touching its runtime directory', async (t) => {
  const f = await fixture(t)
  const external = join(f.root, 'external')
  mkdirSync(external, { recursive: true })
  const instance = await fakeInstance(external, 'external-instance', { pid: process.pid, display: 'wayland-7' })
  const wayland = await listenUnix(join(external, 'wayland-7'))
  t.after(async () => {
    for (const server of [...instance.servers, wayland]) await closeServer(server)
  })
  const report = await attachDesktop({ runtimeDir: external, env: f.env, consentNote: 'user named this desktop' })
  assert.equal(report.state, 'running')
  assert.equal(report.target, 'external')
  assert.equal(report.signature, 'external-instance')
  assert.equal(report.runtimeDir, external)
  assert.equal(report.waylandDisplay, 'wayland-7')
  assert.equal(report.pid, process.pid)
  assert.equal(report.configHash, null)
  assert.deepEqual(report.checks, {
    pid: true, instance: true, controlSocket: true, waylandSocket: true, configHash: true,
  })
  assert.equal(report.detail, null)

  const { record } = await readDesktopRecord(f.env)
  assert.ok(record)
  assert.equal(record.schema, 1)
  assert.equal(record.target, 'external')
  assert.equal(record.configDir, '')
  assert.equal(record.configHash, null)
  assert.equal(record.size, null)
  assert.equal(record.consent.source, 'chat')
  assert.equal(record.consent.note, 'user named this desktop')
  assert.equal(record.detail, null)
  assert.ok(existsSync(join(instance.dir, '.socket.sock')))
  assert.equal(record.pid, process.pid)
})
