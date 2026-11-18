/** Instance discovery without an inherited graphical environment. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import type { Server } from 'node:net'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { discoverSession, listInstanceDirs, readLock } from '../src/session.ts'
import { closeServer, fakeInstance, listenUnix, removeDir, tempDir } from './support.ts'

/** Fixture state tracked for teardown. */
interface RuntimeFixture {
  runtimeDir: string
  servers: Server[]
}

/**
 * Track fixture servers and directories for teardown.
 * @param t Test context.
 * @returns Fixture state.
 */
function runtimeFixture(t: TestContext): RuntimeFixture {
  const runtimeDir = tempDir()
  const servers: Server[] = []
  t.after(async () => {
    for (const server of servers) await closeServer(server)
    removeDir(runtimeDir)
  })
  return { runtimeDir, servers }
}

test('readLock returns the pid and Wayland display', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const instance = await fakeInstance(runtimeDir, 'sig-a', { pid: 4242, display: 'wayland-1' })
  servers.push(...instance.servers)
  assert.deepEqual(readLock(instance.dir), { pid: 4242, waylandDisplay: 'wayland-1' })
})

test('readLock tolerates a lock file without a display line', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const instance = await fakeInstance(runtimeDir, 'sig-a', { pid: 7, display: null })
  servers.push(...instance.servers)
  assert.deepEqual(readLock(instance.dir), { pid: 7, waylandDisplay: null })
})

test('discoverSession scans and prefers the most recently active instance', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const older = await fakeInstance(runtimeDir, 'sig-older', { pid: 1, logMtimeMs: 1_000 })
  const newer = await fakeInstance(runtimeDir, 'sig-newer', { pid: 2, logMtimeMs: 2_000 })
  servers.push(...older.servers, ...newer.servers)
  servers.push(await listenUnix(join(runtimeDir, 'wayland-1')))
  const session = discoverSession({ env: {}, runtimeDir })
  assert.equal(session.signature, 'sig-newer')
  assert.equal(session.pid, 2)
  assert.equal(session.source, 'scan')
  assert.equal(session.instanceCount, 2)
  assert.equal(session.waylandDisplay, 'wayland-1')
  assert.equal(session.waylandDisplaySource, 'lock')
  assert.deepEqual(session.inherited, { waylandDisplay: false, signature: false })
})

test('discoverSession honours an explicit signature and reports inherited environment', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const older = await fakeInstance(runtimeDir, 'sig-older', { pid: 1 })
  const newer = await fakeInstance(runtimeDir, 'sig-newer', { pid: 2 })
  servers.push(...older.servers, ...newer.servers)
  servers.push(await listenUnix(join(runtimeDir, 'wayland-2')))
  const session = discoverSession({
    runtimeDir, signature: 'sig-older',
    env: { WAYLAND_DISPLAY: 'wayland-2', HYPRLAND_INSTANCE_SIGNATURE: 'sig-older' },
  })
  assert.equal(session.signature, 'sig-older')
  assert.equal(session.source, 'explicit')
  assert.equal(session.waylandDisplay, 'wayland-2')
  assert.equal(session.waylandDisplaySource, 'environment')
  assert.deepEqual(session.inherited, { waylandDisplay: true, signature: true })
})

test('discoverSession falls back to a scanned Wayland socket when the lock is silent', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const instance = await fakeInstance(runtimeDir, 'sig-a', { display: null })
  servers.push(...instance.servers)
  servers.push(await listenUnix(join(runtimeDir, 'wayland-7')))
  const session = discoverSession({ env: {}, runtimeDir })
  assert.equal(session.waylandDisplay, 'wayland-7')
  assert.equal(session.waylandDisplaySource, 'socket-scan')
})

test('discoverSession prefers an explicit display override', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const instance = await fakeInstance(runtimeDir, 'sig-a', { display: 'wayland-1' })
  servers.push(...instance.servers)
  servers.push(await listenUnix(join(runtimeDir, 'wayland-1')))
  servers.push(await listenUnix(join(runtimeDir, 'wayland-9')))
  const session = discoverSession({ env: {}, runtimeDir, waylandDisplay: 'wayland-9' })
  assert.equal(session.waylandDisplay, 'wayland-9')
  assert.equal(session.waylandDisplaySource, 'override')
})

test('discoverSession reports running instances when the requested one is absent', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const instance = await fakeInstance(runtimeDir, 'sig-a')
  servers.push(...instance.servers)
  assert.throws(() => discoverSession({ env: {}, runtimeDir, signature: 'sig-missing' }), (error: Error & {
    code?: string
    details?: { running?: string[] }
  }) => {
    assert.equal(error.code, 'NO_SESSION')
    assert.deepEqual(error.details?.running, ['sig-a'])
    return true
  })
})

test('discoverSession fails when no instance directory exists', () => {
  const runtimeDir = tempDir()
  try {
    assert.throws(() => discoverSession({ env: {}, runtimeDir }), (error: Error & { code?: string }) => error.code === 'NO_SESSION')
  } finally {
    removeDir(runtimeDir)
  }
})

test('discoverSession rejects an override whose Wayland socket is missing', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const instance = await fakeInstance(runtimeDir, 'sig-a')
  servers.push(...instance.servers)
  assert.throws(
    () => discoverSession({ env: {}, runtimeDir, waylandDisplay: 'wayland-404' }),
    (error: Error & { code?: string }) => error.code === 'NO_SESSION',
  )
})

test('listInstanceDirs requires a control socket', async (t) => {
  const { runtimeDir, servers } = runtimeFixture(t)
  const instance = await fakeInstance(runtimeDir, 'sig-a')
  servers.push(...instance.servers)
  mkdirSync(join(runtimeDir, 'hypr', 'dir-without-socket'), { recursive: true })
  const dirs = listInstanceDirs(runtimeDir)
  assert.deepEqual(dirs.map(dir => dir.signature), ['sig-a'])
})
