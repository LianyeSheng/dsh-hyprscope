/** Allowlisted Lua expressions, request validation, and the lease gate around a dispatch. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DISPATCH_KINDS, assertDispatchRequest, dispatchWithLease, luaExpression,
  type DispatchRequest,
} from '../src/control/dispatch.ts'
import { ErrorCode, HyprscopeError } from '../src/errors.ts'
import { fakeSession, removeDir, tempDir, writeScript } from './support.ts'

const ADDRESS = '0x55a1'

/**
 * Accept only USAGE-coded dispatch rejections.
 * @param error Thrown value.
 * @returns True after asserting the code.
 */
function isUsageError(error: unknown): boolean {
  assert.ok(error instanceof HyprscopeError, `expected a HyprscopeError, got ${String(error)}`)
  assert.equal(error.code, ErrorCode.USAGE)
  return true
}

/**
 * Write a fake `hyprctl` that records the arguments of the dispatch call.
 * @param directory Fixture directory.
 * @returns Script path and the argument log path.
 */
function fakeHyprctl(directory: string): { script: string; log: string } {
  const log = join(directory, 'dispatch.log')
  const script = writeScript(directory, 'hyprctl', [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${log}"`,
    '',
  ].join('\n'))
  return { script, log }
}

test('luaExpression emits the verified Lua shape for every kind', () => {
  const cases: { request: DispatchRequest; expression: string }[] = [
    {
      request: { kind: 'focusWindow', windowId: ADDRESS },
      expression: 'hl.dsp.focus({ window = "address:0x55a1" })',
    },
    {
      request: { kind: 'workspace', name: 'agent' },
      expression: 'hl.dsp.focus({ workspace = "agent" })',
    },
    {
      request: { kind: 'moveWindow', windowId: ADDRESS, x: 10, y: -20 },
      expression: 'hl.dsp.window.move({ window = "address:0x55a1", x = 10, y = -20 })',
    },
    {
      request: { kind: 'resizeWindow', windowId: ADDRESS, x: 800, y: 600 },
      expression: 'hl.dsp.window.resize({ window = "address:0x55a1", x = 800, y = 600 })',
    },
    {
      request: { kind: 'moveWindowToWorkspace', windowId: ADDRESS, workspace: 'agent-2', silent: true },
      expression: 'hl.dsp.window.move({ window = "address:0x55a1", workspace = "agent-2", follow = false })',
    },
    {
      request: { kind: 'moveWindowToWorkspace', windowId: ADDRESS, workspace: 'agent-2', silent: false },
      expression: 'hl.dsp.window.move({ window = "address:0x55a1", workspace = "agent-2", follow = true })',
    },
    {
      request: { kind: 'floatWindow', windowId: ADDRESS, floating: true },
      expression: 'hl.dsp.window.float({ window = "address:0x55a1", action = "on" })',
    },
    {
      request: { kind: 'floatWindow', windowId: ADDRESS, floating: false },
      expression: 'hl.dsp.window.float({ window = "address:0x55a1", action = "off" })',
    },
    {
      request: { kind: 'pinWindow', windowId: ADDRESS, pinned: true },
      expression: 'hl.dsp.window.pin({ action = "on", window = "address:0x55a1" })',
    },
    {
      request: { kind: 'pinWindow', windowId: ADDRESS, pinned: false },
      expression: 'hl.dsp.window.pin({ action = "off", window = "address:0x55a1" })',
    },
    {
      request: { kind: 'fullscreenWindow', windowId: ADDRESS, internal: 2, client: 1 },
      expression: 'hl.dsp.window.fullscreen_state({ window = "address:0x55a1", internal = 2, client = 1, action = "set" })',
    },
  ]
  for (const { request, expression } of cases) assert.equal(luaExpression(request), expression)
})

test('DISPATCH_KINDS matches the request union in order', () => {
  assert.deepEqual([...DISPATCH_KINDS], [
    'focusWindow', 'workspace', 'moveWindow', 'resizeWindow',
    'moveWindowToWorkspace', 'floatWindow', 'pinWindow', 'fullscreenWindow',
  ])
})

test('fullscreenWindow only emits the three accepted modes', () => {
  for (const internal of [0, 1, 2] as const) {
    for (const client of [0, 1, 2] as const) {
      assert.equal(
        luaExpression({ kind: 'fullscreenWindow', windowId: ADDRESS, internal, client }),
        `hl.dsp.window.fullscreen_state({ window = "address:0x55a1", internal = ${internal}, client = ${client}, action = "set" })`,
      )
    }
  }
})

test('moveWindow is absolute and carries no bogus exact field', () => {
  const expression = luaExpression({ kind: 'moveWindow', windowId: ADDRESS, x: 1, y: 2 })
  assert.equal(expression, 'hl.dsp.window.move({ window = "address:0x55a1", x = 1, y = 2 })')
  assert.ok(!expression.includes('exact'))
  assert.ok(!expression.includes('relative'))
})

test('assertDispatchRequest rejects malformed values before any Lua is built', () => {
  const rejected: unknown[] = [
    { kind: 'workspace', name: 'agent" }) os.execute("true' },
    { kind: 'workspace', name: 'a b' },
    { kind: 'workspace', name: '' },
    { kind: 'workspace', name: 'a'.repeat(33) },
    { kind: 'workspace', name: 'agent\\' },
    { kind: 'workspace', name: 'agent\n' },
    { kind: 'workspace', name: 7 },
    { kind: 'focusWindow', windowId: 'address:0x55a1' },
    { kind: 'focusWindow', windowId: '0x55A1' },
    { kind: 'focusWindow', windowId: '0x55a1" }) os.exit()' },
    { kind: 'focusWindow' },
    { kind: 'moveWindow', windowId: '0x55a1', x: 1.5, y: 2 },
    { kind: 'moveWindow', windowId: '0x55a1', x: 1, y: 2_000_000 },
    { kind: 'resizeWindow', windowId: '0x55a1', x: Number.NaN, y: 2 },
    { kind: 'resizeWindow', windowId: '0x55a1', x: 800 },
    { kind: 'moveWindowToWorkspace', windowId: '0x55a1', workspace: 'agent', silent: 'yes' },
    { kind: 'moveWindowToWorkspace', windowId: '0x55a1', workspace: 'agent' },
    { kind: 'moveWindowToWorkspace', windowId: '0x55a1', workspace: 'a b', silent: true },
    { kind: 'floatWindow', windowId: '0x55a1', floating: 'on' },
    { kind: 'floatWindow', windowId: '0x55a1' },
    { kind: 'pinWindow', windowId: '0x55a1', pinned: 'on' },
    { kind: 'fullscreenWindow', windowId: '0x55a1', internal: 3, client: 0 },
    { kind: 'fullscreenWindow', windowId: '0x55a1', internal: 0, client: -1 },
    { kind: 'fullscreenWindow', windowId: '0x55a1', internal: '1', client: 0 },
    { kind: 'fullscreenWindow', windowId: '0x55a1', internal: 0, client: 1.5 },
    { kind: 'exec', args: ['rm', '-rf', '~'] },
    { kind: 'dispatch', expression: 'os.execute("id")' },
  ]
  for (const request of rejected) {
    assert.throws(() => { assertDispatchRequest(request as never) }, isUsageError)
    assert.throws(() => luaExpression(request as never), isUsageError)
  }
})

test('validated values cannot break out of their Lua string literal', () => {
  const names = ['agent', '1', 'team-2', '_scratch', 'a.b_c', 'X'.repeat(32)]
  for (const name of names) {
    assert.match(
      luaExpression({ kind: 'workspace', name }),
      /^hl\.dsp\.focus\(\{ workspace = "[A-Za-z0-9._-]{1,32}" \}\)$/,
    )
    assert.match(
      luaExpression({ kind: 'moveWindowToWorkspace', windowId: ADDRESS, workspace: name, silent: true }),
      /^hl\.dsp\.window\.move\(\{ window = "address:0x[0-9a-f]+", workspace = "[A-Za-z0-9._-]{1,32}", follow = false \}\)$/,
    )
  }
  const payloads = [
    'agent" }) os.execute("id")',
    "agent' .. os.execute('id') .. '",
    'agent\\',
    'agent\n}) os.execute("id")',
    'agent\0tail',
    'agent ) os.execute("id") (',
    'agent`..`',
    'agent\t',
  ]
  for (const name of payloads) {
    assert.throws(() => luaExpression({ kind: 'workspace', name }), isUsageError)
    assert.throws(
      () => luaExpression({ kind: 'moveWindowToWorkspace', windowId: ADDRESS, workspace: name, silent: true }),
      isUsageError,
    )
  }
})

test('foreign fields cannot ride into the expression', () => {
  const tainted = {
    kind: 'floatWindow' as const,
    windowId: ADDRESS,
    floating: true,
    extra: 'os.execute("id")',
  }
  assert.equal(luaExpression(tainted), 'hl.dsp.window.float({ window = "address:0x55a1", action = "on" })')
  const taintedMove = { kind: 'moveWindow' as const, windowId: ADDRESS, x: 1, y: 2, exact: true, relative: true }
  assert.equal(luaExpression(taintedMove), 'hl.dsp.window.move({ window = "address:0x55a1", x = 1, y = 2 })')
})

test('dispatchWithLease sends the built expression only after the guard passes', async (t) => {
  const directory = tempDir('hyprscope-dispatch-')
  t.after(() => { removeDir(directory) })
  const { script, log } = fakeHyprctl(directory)
  let guarded = false
  await dispatchWithLease(
    fakeSession(),
    async () => { guarded = true },
    { kind: 'moveWindowToWorkspace', windowId: ADDRESS, workspace: 'agent', silent: true },
    { binary: script, timeoutMs: 5_000 },
  )
  assert.equal(guarded, true)
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'dispatch',
    'hl.dsp.window.move({ window = "address:0x55a1", workspace = "agent", follow = false })',
  ])
})

test('dispatchWithLease refuses a malformed request before the guard or the binary', async (t) => {
  const directory = tempDir('hyprscope-dispatch-')
  t.after(() => { removeDir(directory) })
  const { script, log } = fakeHyprctl(directory)
  let guarded = false
  await assert.rejects(
    dispatchWithLease(
      fakeSession(),
      async () => { guarded = true },
      { kind: 'workspace', name: 'a b' } as never,
      { binary: script, timeoutMs: 5_000 },
    ),
    isUsageError,
  )
  assert.equal(guarded, false)
  assert.throws(() => readFileSync(log, 'utf8'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
})

test('dispatchWithLease runs nothing when the lease guard refuses', async (t) => {
  const directory = tempDir('hyprscope-dispatch-')
  t.after(() => { removeDir(directory) })
  const { script, log } = fakeHyprctl(directory)
  let guarded = false
  await assert.rejects(
    dispatchWithLease(
      fakeSession(),
      async () => {
        guarded = true
        throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'Control was revoked')
      },
      { kind: 'floatWindow', windowId: ADDRESS, floating: true },
      { binary: script, timeoutMs: 5_000 },
    ),
    (error: unknown) => error instanceof HyprscopeError && error.code === ErrorCode.LEASE_MISMATCH,
  )
  assert.equal(guarded, true)
  assert.throws(() => readFileSync(log, 'utf8'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
})
