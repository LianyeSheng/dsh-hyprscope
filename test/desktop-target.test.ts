/** Desktop target resolution: default safety, record liveness, and baseline keys. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import type { Server } from 'node:net'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { baselinePaths } from '../src/compat/baseline.ts'
import { writeDesktopRecord } from '../src/desktop/record.ts'
import { baselinePathsForTarget, parseDesktopTarget, resolveTarget } from '../src/desktop/target.ts'
import type { DesktopRecord } from '../src/desktop/types.ts'
import { ErrorCode, HyprscopeError } from '../src/errors.ts'
import { closeServer, fakeInstance, listenUnix, removeDir, tempDir } from './support.ts'

/** Isolated runtime and state directories plus the servers to close. */
interface Fixture {
  root: string
  runtimeDir: string
  stateHome: string
  env: NodeJS.ProcessEnv
  servers: Server[]
}

/**
 * Create an isolated runtime and state home.
 * @param t Test context.
 * @returns Paths and the environment that points at them, for teardown.
 */
function fixture(t: TestContext): Fixture {
  const root = tempDir('hyprscope-target-')
  const runtimeDir = join(root, 'run')
  const stateHome = join(root, 'state')
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(stateHome, { recursive: true })
  const servers: Server[] = []
  t.after(async () => {
    for (const server of servers) {
      if (server.listening) await closeServer(server)
    }
    removeDir(root)
  })
  return {
    root,
    runtimeDir,
    stateHome,
    env: { XDG_STATE_HOME: stateHome, XDG_RUNTIME_DIR: runtimeDir },
    servers,
  }
}

/** Lock and socket shape of one fake instance. */
interface InstanceOptions {
  pid?: number
  display?: string
  logMtimeMs?: number
  /** Set false to leave the Wayland socket missing. */
  wayland?: boolean
}

/**
 * Start one fake Hyprland instance with live sockets.
 * @param f Fixture to populate.
 * @param signature Instance signature.
 * @param options Lock fields and which sockets to create.
 * @returns Instance directory.
 */
async function startInstance(f: Fixture, signature: string, options: InstanceOptions = {}): Promise<string> {
  const display = options.display ?? 'wayland-1'
  const instance = await fakeInstance(f.runtimeDir, signature, {
    pid: options.pid ?? 4_242,
    display,
    logMtimeMs: options.logMtimeMs,
  })
  f.servers.push(...instance.servers)
  if (options.wayland !== false) f.servers.push(await listenUnix(join(f.runtimeDir, display)))
  return instance.dir
}

/** Fields a test must supply; the rest come from {@link makeRecord}. */
type RecordSeed = Partial<DesktopRecord> & Pick<DesktopRecord, 'target' | 'runtimeDir' | 'signature'>

/**
 * Build one valid record.
 * @param seed Fields that select the desktop.
 * @returns Record with every required field filled in.
 */
function makeRecord(seed: RecordSeed): DesktopRecord {
  return {
    schema: 1,
    state: 'running',
    waylandDisplay: 'wayland-1',
    pid: null,
    configDir: '',
    configHash: null,
    size: null,
    consent: { source: 'chat', at: '2026-11-17T00:00:00.000Z', note: null },
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    detail: null,
    ...seed,
  }
}

/**
 * Capture a rejected HyprscopeError.
 * @param promise Work expected to fail.
 * @returns The coded failure.
 */
async function rejection(promise: Promise<unknown>): Promise<HyprscopeError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof HyprscopeError, `expected HyprscopeError, got ${String(error)}`)
    return error
  }
  assert.fail('expected the promise to reject')
}

/**
 * Capture a thrown HyprscopeError.
 * @param action Work expected to throw.
 * @returns The coded failure.
 */
function thrown(action: () => unknown): HyprscopeError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof HyprscopeError, `expected HyprscopeError, got ${String(error)}`)
    return error
  }
  assert.fail('expected the call to throw')
}

test('parseDesktopTarget defaults to the user desktop and passes known targets through', () => {
  const matrix: ReadonlyArray<readonly [string | undefined, 'user' | 'agent' | 'external']> = [
    [undefined, 'user'],
    ['', 'user'],
    ['user', 'user'],
    ['agent', 'agent'],
    ['external', 'external'],
  ]
  for (const [value, expected] of matrix) {
    assert.equal(parseDesktopTarget(value), expected)
  }
})

test('parseDesktopTarget rejects an unknown selector with USAGE', () => {
  const error = thrown(() => parseDesktopTarget('nested'))
  assert.equal(error.code, ErrorCode.USAGE)
  assert.equal(error.message, 'Unknown desktop nested; expected user, agent, or external')
  assert.equal(error.details.value, 'nested')
})

test('user target picks the user instance when a newer managed one runs', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-user', { pid: 111, display: 'wayland-1', logMtimeMs: 1_000 })
  await startInstance(f, 'sig-agent', { pid: 222, display: 'wayland-2', logMtimeMs: 2_000 })
  await writeDesktopRecord(f.env, makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-agent',
    waylandDisplay: 'wayland-2',
    pid: 222,
    configHash: 'agent-hash',
  }))
  const resolved = await resolveTarget('user', { env: f.env })
  assert.equal(resolved.target, 'user')
  assert.equal(resolved.session.signature, 'sig-user')
  assert.equal(resolved.signature, 'sig-user')
  assert.equal(resolved.desktop, null)
  assert.equal(resolved.baselineSignature, null)
  assert.equal(resolved.configHash, null)
  assert.equal(resolved.env, f.env)
})

test('user target defaults to the newest instance when no record exists', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-older', { display: 'wayland-1', logMtimeMs: 1_000 })
  await startInstance(f, 'sig-newer', { display: 'wayland-2', logMtimeMs: 2_000 })
  const resolved = await resolveTarget('user', { env: f.env })
  assert.equal(resolved.session.signature, 'sig-newer')
  assert.equal(resolved.session.source, 'scan')
})

test('an explicit signature selects the recorded instance despite managed exclusion', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-user', { display: 'wayland-1', logMtimeMs: 1_000 })
  await startInstance(f, 'sig-agent', { display: 'wayland-2', logMtimeMs: 2_000 })
  await writeDesktopRecord(f.env, makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-agent',
    waylandDisplay: 'wayland-2',
  }))
  const resolved = await resolveTarget('user', { env: f.env, signature: 'sig-agent' })
  assert.equal(resolved.target, 'user')
  assert.equal(resolved.session.signature, 'sig-agent')
  assert.equal(resolved.session.source, 'explicit')
  assert.equal(resolved.desktop, null)
  assert.equal(resolved.env, f.env)
})

test('user target propagates NO_SESSION when no instance runs', async (t) => {
  const f = fixture(t)
  const error = await rejection(resolveTarget('user', { env: f.env }))
  assert.equal(error.code, ErrorCode.NO_SESSION)
})

test('user target refuses to silently become the managed agent desktop', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-agent', { display: 'wayland-2' })
  await writeDesktopRecord(f.env, makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-agent',
    waylandDisplay: 'wayland-2',
  }))
  const error = await rejection(resolveTarget('user', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.match(error.message, /only the managed agent desktop is running; pass --desktop agent/)
  assert.equal(error.details.managedSignature, 'sig-agent')
})

test('agent resolves a live record and pins HYPRSCOPE_LEASE_SIGNATURE', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-agent', { pid: process.pid, display: 'wayland-3' })
  const stored = makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-agent',
    waylandDisplay: 'wayland-3',
    pid: process.pid,
    configDir: join(f.stateHome, 'hyprscope', 'desktop', 'config'),
    configHash: 'abc123',
  })
  await writeDesktopRecord(f.env, stored)
  const input = { ...f.env, HYPRSCOPE_LEASE_SIGNATURE: 'stale-sig' }
  const resolved = await resolveTarget('agent', { env: input })
  assert.equal(resolved.target, 'agent')
  assert.equal(resolved.session.signature, 'sig-agent')
  assert.equal(resolved.signature, 'sig-agent')
  assert.equal(resolved.baselineSignature, 'sig-agent')
  assert.equal(resolved.configHash, 'abc123')
  assert.equal(resolved.env.HYPRSCOPE_LEASE_SIGNATURE, 'sig-agent')
  assert.equal(resolved.env.XDG_STATE_HOME, f.stateHome)
  assert.equal(input.HYPRSCOPE_LEASE_SIGNATURE, 'stale-sig')
  assert.deepEqual(resolved.desktop, stored)
})

test('an injected record skips the on-disk record', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-agent', { pid: process.pid, display: 'wayland-7' })
  const injected = makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-agent',
    waylandDisplay: 'wayland-7',
    pid: process.pid,
  })
  const resolved = await resolveTarget('agent', { env: f.env, record: injected })
  assert.deepEqual(resolved.desktop, injected)
})

test('agent rejects a closed record', async (t) => {
  const f = fixture(t)
  await writeDesktopRecord(f.env, makeRecord({
    target: 'agent',
    state: 'closed',
    runtimeDir: f.runtimeDir,
    signature: 'sig-gone',
  }))
  const error = await rejection(resolveTarget('agent', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.match(error.message, /closed\/stale/)
  assert.match(error.message, /run hyprscope control desktop start/)
  assert.equal(error.details.detail, 'the desktop is closed/stale')
})

test('agent rejects a record whose instance directory was removed', async (t) => {
  const f = fixture(t)
  const instance = await fakeInstance(f.runtimeDir, 'sig-gone', { display: 'wayland-9' })
  f.servers.push(await listenUnix(join(f.runtimeDir, 'wayland-9')))
  for (const server of instance.servers) await closeServer(server)
  rmSync(instance.dir, { recursive: true, force: true })
  await writeDesktopRecord(f.env, makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-gone',
    waylandDisplay: 'wayland-9',
  }))
  const error = await rejection(resolveTarget('agent', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.match(error.message, /instance directory .* is missing/)
})

test('agent rejects a record whose compositor pid is gone', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-agent', { pid: 4_242, display: 'wayland-4' })
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  await writeDesktopRecord(f.env, makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-agent',
    waylandDisplay: 'wayland-4',
    pid: dead,
  }))
  const error = await rejection(resolveTarget('agent', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.match(error.message, /compositor process \d+ is gone/)
})

test('agent rejects when no record exists', async (t) => {
  const f = fixture(t)
  const error = await rejection(resolveTarget('agent', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.equal(error.message, 'No agent desktop is running; run hyprscope control desktop start')
})

test('agent rejects a record that belongs to the external target', async (t) => {
  const f = fixture(t)
  await writeDesktopRecord(f.env, makeRecord({
    target: 'external',
    runtimeDir: f.runtimeDir,
    signature: 'sig-external',
  }))
  const error = await rejection(resolveTarget('agent', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.equal(error.message, 'No agent desktop is running; run hyprscope control desktop start')
  assert.equal(error.details.recordedTarget, 'external')
})

test('external resolves a live attached record with a null pid', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-external', { pid: 7_777, display: 'wayland-5' })
  const stored = makeRecord({
    target: 'external',
    runtimeDir: f.runtimeDir,
    signature: 'sig-external',
    waylandDisplay: 'wayland-5',
    pid: null,
  })
  await writeDesktopRecord(f.env, stored)
  const resolved = await resolveTarget('external', { env: f.env })
  assert.equal(resolved.target, 'external')
  assert.equal(resolved.signature, 'sig-external')
  assert.equal(resolved.baselineSignature, 'sig-external')
  assert.equal(resolved.configHash, null)
  assert.equal(resolved.env.HYPRSCOPE_LEASE_SIGNATURE, 'sig-external')
  assert.equal(resolved.session.waylandDisplay, 'wayland-5')
  assert.deepEqual(resolved.desktop, stored)
})

test('external rejects a record whose Wayland socket is gone', async (t) => {
  const f = fixture(t)
  await startInstance(f, 'sig-external', { display: 'wayland-6', wayland: false })
  await writeDesktopRecord(f.env, makeRecord({
    target: 'external',
    runtimeDir: f.runtimeDir,
    signature: 'sig-external',
    waylandDisplay: 'wayland-6',
  }))
  const error = await rejection(resolveTarget('external', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.match(error.message, /Wayland socket .* is missing/)
  assert.match(error.message, /run hyprscope control desktop attach/)
  assert.equal(error.details.detail, 'the desktop is closed/stale')
})

test('external rejects a record that belongs to the agent target', async (t) => {
  const f = fixture(t)
  await writeDesktopRecord(f.env, makeRecord({
    target: 'agent',
    runtimeDir: f.runtimeDir,
    signature: 'sig-agent',
  }))
  const error = await rejection(resolveTarget('external', { env: f.env }))
  assert.equal(error.code, ErrorCode.TARGET_UNAVAILABLE)
  assert.equal(error.message, 'No external desktop is attached; run hyprscope control desktop attach')
  assert.equal(error.details.recordedTarget, 'agent')
})

test('baselinePathsForTarget keeps user and instance baselines separate', (t) => {
  const stateHome = tempDir('hyprscope-baseline-')
  t.after(() => removeDir(stateHome))
  const env = { XDG_STATE_HOME: stateHome }
  assert.deepEqual(baselinePathsForTarget(env, 'user', null), baselinePaths(env))
  assert.deepEqual(baselinePathsForTarget(env, 'user', 'sig-ignored'), baselinePaths(env))
  for (const target of ['agent', 'external'] as const) {
    const paths = baselinePathsForTarget(env, target, 'sig-one')
    assert.deepEqual(paths, baselinePaths(env, { signature: 'sig-one' }))
    assert.equal(paths.baselineFile, join(stateHome, 'hyprscope', 'desktop', 'baseline', 'sig-one.json'))
  }
})

test('baselinePathsForTarget requires a signature for a recorded desktop', (t) => {
  const stateHome = tempDir('hyprscope-baseline-')
  t.after(() => removeDir(stateHome))
  const env = { XDG_STATE_HOME: stateHome }
  for (const target of ['agent', 'external'] as const) {
    for (const signature of [null, ''] as const) {
      const error = thrown(() => baselinePathsForTarget(env, target, signature))
      assert.equal(error.code, ErrorCode.USAGE)
      assert.match(error.message, /no instance signature/)
    }
  }
})
