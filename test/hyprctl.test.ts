/** Read-only guard, subprocess wiring, and JSON parsing for hyprctl. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { READ_ONLY_COMMANDS, assertReadOnlyCommand, hyprctlJson } from '../src/hyprctl.ts'
import type { RawClient } from '../src/types.ts'
import { fakeSession, removeDir, tempDir, writeScript } from './support.ts'

const MUTATING = [
  'dispatch', 'keyword', 'eval', 'repl', 'kill', 'reload', 'setprop', 'output',
  'plugin', 'setcursor', 'seterror', 'notify', 'dismissnotify', 'hyprpaper', 'hyprsunset',
]

test('assertReadOnlyCommand accepts every read-only command', () => {
  for (const command of READ_ONLY_COMMANDS) assert.equal(assertReadOnlyCommand(command), command)
})

test('assertReadOnlyCommand rejects mutating commands before any process starts', () => {
  for (const command of MUTATING) {
    assert.throws(() => assertReadOnlyCommand(command), (error: Error & { code?: string; details?: { command?: string } }) => {
      assert.equal(error.code, 'READ_ONLY')
      assert.equal(error.details?.command, command)
      return true
    })
  }
})

/**
 * Write a fake `hyprctl` that records its arguments and environment.
 * @param directory Fixture directory.
 * @param standardOutput Text to print.
 * @param options Extra script body or failure exit.
 * @returns Script and its argument log path.
 */
function fakeHyprctl(directory: string, standardOutput: string, options: { body?: string; exitCode?: number } = {}): {
  script: string
  log: string
} {
  const log = join(directory, 'args.log')
  const script = writeScript(directory, 'hyprctl', [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${log}"`,
    `printf '%s\\n' "$HYPRLAND_INSTANCE_SIGNATURE" >> "${log}"`,
    `printf '%s\\n' "$XDG_RUNTIME_DIR" >> "${log}"`,
    options.body ?? '',
    `printf '%s' '${standardOutput}'`,
    `exit ${options.exitCode ?? 0}`,
    '',
  ].join('\n'))
  return { script, log }
}

test('hyprctlJson passes -j, the command, and the session environment', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const { script, log } = fakeHyprctl(directory, '{"ok":true}')
  const value = await hyprctlJson<{ ok: boolean }>(fakeSession(), 'clients', [], { binary: script })
  assert.deepEqual(value, { ok: true })
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.deepEqual(lines.slice(0, 4), ['-j', 'clients', 'test-signature', '/run/user/1000'])
})

test('hyprctlJson returns null for empty output', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const { script } = fakeHyprctl(directory, '')
  assert.equal(await hyprctlJson<RawClient>(fakeSession(), 'activewindow', [], { binary: script }), null)
})

test('hyprctlJson reports BAD_OUTPUT for non-JSON output', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const { script } = fakeHyprctl(directory, 'not json')
  await assert.rejects(hyprctlJson<unknown>(fakeSession(), 'clients', [], { binary: script }),
    (error: Error & { code?: string }) => error.code === 'BAD_OUTPUT')
})

test('hyprctlJson reports COMMAND_FAILED with the exit code', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const { script } = fakeHyprctl(directory, '', { body: 'echo boom >&2', exitCode: 3 })
  await assert.rejects(hyprctlJson<unknown>(fakeSession(), 'clients', [], { binary: script }),
    (error: Error & { code?: string; details?: { exitCode?: number; stderr?: string } }) => {
      assert.equal(error.code, 'COMMAND_FAILED')
      assert.equal(error.details?.exitCode, 3)
      assert.equal(error.details?.stderr, 'boom')
      return true
    })
})

test('hyprctlJson reports SESSION_GONE when the compositor is unreachable', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const { script } = fakeHyprctl(directory, '', {
    body: 'echo \'HYPRLAND_INSTANCE_SIGNATURE not set! (is hyprland running?)\' >&2', exitCode: 1,
  })
  await assert.rejects(hyprctlJson<unknown>(fakeSession(), 'version', [], { binary: script }),
    (error: Error & { code?: string }) => error.code === 'SESSION_GONE')
})

test('hyprctlJson refuses a mutating command without executing the binary', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const { script, log } = fakeHyprctl(directory, '{}')
  await assert.rejects(hyprctlJson<unknown>(fakeSession(), 'dispatch', [], { binary: script }),
    (error: Error & { code?: string }) => error.code === 'READ_ONLY')
  assert.throws(() => readFileSync(log, 'utf8'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
})
