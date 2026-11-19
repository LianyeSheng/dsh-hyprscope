/** Unit tests for the desktop-message CLI surface and its state files. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'

import { main as entryMain } from '../src/entry.ts'
import { main as messageMain, parseMessageArgs } from '../src/message/cli.ts'
import {
  messageDirectory, messagePaths, readShortcutKey, readStatus, statusFresh, writeJsonAtomic,
} from '../src/message/state.ts'
import { closeServer, fakeInstance, listenUnix, removeDir, sink, tempDir, writeScript } from './support.ts'

/**
 * Create a fake Hyprland runtime directory with a Wayland socket.
 * @param {import('node:test').TestContext} t Test context.
 * @returns {Promise<{ runtimeDir: string, close: () => Promise<void> }>} Fixture facts.
 */
async function makeRuntime(t: TestContext) {
  const runtimeDir = tempDir('hyprscope-message-runtime-')
  const instance = await fakeInstance(runtimeDir, 'sig-message', { pid: process.pid, display: 'wayland-1' })
  const wayland = await listenUnix(join(runtimeDir, 'wayland-1'))
  t.after(async () => {
    await closeServer(wayland)
    for (const server of instance.servers) await closeServer(server)
    removeDir(runtimeDir)
  })
  return { runtimeDir, close: async () => {} }
}

/**
 * Build the environment one message command reads.
 * @param {object} overrides Environment overrides.
 * @returns {NodeJS.ProcessEnv} Environment.
 */
function messageEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides }
}

/**
 * Wait until a file exists, polling the event loop.
 * @param {() => boolean} predicate Condition.
 * @param {string} label Failure label.
 */
async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => { setTimeout(resolve, 20) })
  }
  throw new Error('timed out waiting for ' + label)
}

/**
 * Write a fresh status record.
 * @param {string} directory Message directory.
 * @param {object} overrides Status overrides.
 */
function writeStatus(directory: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(join(directory, 'status.json'), JSON.stringify({
    version: 1,
    alive: true,
    pid: 1234,
    updatedAt: new Date().toISOString(),
    language: 'zh',
    attachScreenshot: true,
    sessionId: null,
    error: null,
    ...overrides,
  }))
}

test('parseMessageArgs accepts the message commands and validates the language', () => {
  assert.deepEqual(parseMessageArgs(['open', '--json', '--lang', 'en']), {
    command: 'open', options: { json: true, help: false, lang: 'en' }, args: [],
  })
  assert.equal(parseMessageArgs(['--lang=en', 'overlay']).options.lang, 'en')
  assert.throws(() => parseMessageArgs(['open', '--lang', 'fr']), /--lang expects/)
  assert.throws(() => parseMessageArgs(['open', '--nope']), /Unknown option/)
})

test('messageDirectory honours the override and the XDG state home', () => {
  assert.equal(messageDirectory({ HYPRSCOPE_MESSAGE_DIR: '/tmp/one' }), '/tmp/one')
  assert.equal(messageDirectory({ XDG_STATE_HOME: '/state', HOME: '/home/x' }), '/state/hyprscope/message')
  assert.equal(messageDirectory({ HOME: '/home/x' }), '/home/x/.local/state/hyprscope/message')
})

test('state helpers treat a malformed status as absent and a fresh one as live', async (t) => {
  const directory = tempDir('hyprscope-message-state-')
  t.after(() => removeDir(directory))
  const paths = messagePaths(directory)
  writeFileSync(paths.statusFile, 'not json')
  assert.equal(await readStatus(paths), null)
  await writeJsonAtomic(paths.statusFile, {
    version: 1,
    alive: true,
    pid: 1,
    updatedAt: new Date().toISOString(),
    language: 'zh',
    attachScreenshot: false,
    sessionId: null,
    error: null,
  })
  const status = await readStatus(paths)
  assert.ok(status !== null)
  assert.equal(statusFresh(status), true)
  assert.equal(statusFresh(status, Date.now() + 60_000), false)
  assert.equal(await readShortcutKey(paths), 'SUPER + ALT + M')
  writeFileSync(paths.shortcutFile, 'SUPER + ALT + K')
  assert.equal(await readShortcutKey(paths), 'SUPER + ALT + K')
})

test('open starts the overlay, records the request and reports the Host state', async (t) => {
  const runtime = await makeRuntime(t)
  const directory = tempDir('hyprscope-message-open-')
  const tools = tempDir('hyprscope-message-tools-')
  t.after(() => {
    removeDir(directory)
    removeDir(tools)
  })
  writeStatus(directory)
  writeFileSync(join(directory, 'quit.json'), JSON.stringify({ at: new Date().toISOString() }))
  const qs = writeScript(tools, 'quickshell', [
    '#!/bin/sh',
    'printf "%s" "$*" > "$HYPRSCOPE_MESSAGE_DIR/qs-args.txt"',
    'printf "%s|%s|%s" "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" "$HYPRSCOPE_MESSAGE_LANG" > "$HYPRSCOPE_MESSAGE_DIR/qs-env.txt"',
    'exit 0',
  ].join(String.fromCharCode(10)))
  const env = messageEnv({
    XDG_RUNTIME_DIR: runtime.runtimeDir,
    HYPRSCOPE_MESSAGE_DIR: directory,
    HYPRSCOPE_QUICKSHELL: qs,
  })
  const stdout = sink()
  const stderr = sink()
  const code = await messageMain(['open', '--json', '--lang', 'en'], { stdout, stderr }, env)
  assert.equal(code, 0)
  assert.equal(stderr.text, '')
  const value = JSON.parse(stdout.text)
  assert.equal(value.command, 'open')
  assert.equal(value.dsh, 'available')
  assert.equal(value.dir, directory)
  assert.equal(typeof value.overlay.pid, 'number')
  assert.equal(typeof value.request.nonce, 'string')
  const request = JSON.parse(readFileSync(join(directory, 'open.json'), 'utf8'))
  assert.equal(request.nonce, value.request.nonce)
  assert.equal(existsSync(join(directory, 'quit.json')), false)
  await waitFor(() => existsSync(join(directory, 'qs-env.txt')), 'the overlay environment file')
  const overlayEnv = readFileSync(join(directory, 'qs-env.txt'), 'utf8')
  assert.equal(overlayEnv, 'wayland-1|' + runtime.runtimeDir + '|en')
  const overlayArgs = readFileSync(join(directory, 'qs-args.txt'), 'utf8')
  assert.ok(overlayArgs.includes('-p ' + 'overlay/message') || overlayArgs.includes('overlay/message'))
  assert.ok(overlayArgs.endsWith(' -n'))
})

test('open reports an unavailable Host when no heartbeat is fresh', async (t) => {
  const runtime = await makeRuntime(t)
  const directory = tempDir('hyprscope-message-stale-')
  const tools = tempDir('hyprscope-message-tools-stale-')
  t.after(() => {
    removeDir(directory)
    removeDir(tools)
  })
  writeStatus(directory, { updatedAt: new Date(Date.now() - 60_000).toISOString() })
  const qs = writeScript(tools, 'quickshell', '#!/bin/sh' + String.fromCharCode(10) + 'exit 0' + String.fromCharCode(10))
  const env = messageEnv({
    XDG_RUNTIME_DIR: runtime.runtimeDir,
    HYPRSCOPE_MESSAGE_DIR: directory,
    HYPRSCOPE_QUICKSHELL: qs,
  })
  const stdout = sink()
  const code = await messageMain(['open', '--json'], { stdout, stderr: sink() }, env)
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout.text).dsh, 'unavailable')
})

test('open fails with OVERLAY_FAILED when the overlay binary cannot start', async (t) => {
  const runtime = await makeRuntime(t)
  const directory = tempDir('hyprscope-message-missing-')
  t.after(() => removeDir(directory))
  const env = messageEnv({
    XDG_RUNTIME_DIR: runtime.runtimeDir,
    HYPRSCOPE_MESSAGE_DIR: directory,
    HYPRSCOPE_QUICKSHELL: join(directory, 'missing-quickshell'),
  })
  const stderr = sink()
  const code = await messageMain(['open', '--json'], { stdout: sink(), stderr }, env)
  assert.equal(code, 1)
  const failure = JSON.parse(stderr.text.trim()).error
  assert.equal(failure.code, 'OVERLAY_FAILED')
  assert.match(failure.message, /Cannot start the desktop-message overlay/)
})

test('stop records an exit request without needing a running compositor', async (t) => {
  const runtime = tempDir('hyprscope-message-no-session-')
  const directory = tempDir('hyprscope-message-stop-')
  t.after(() => {
    removeDir(runtime)
    removeDir(directory)
  })
  const stdout = sink()
  const env = messageEnv({ XDG_RUNTIME_DIR: runtime, HYPRSCOPE_MESSAGE_DIR: directory })
  const code = await messageMain(['stop', '--json'], { stdout, stderr: sink() }, env)
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout.text).command, 'stop')
  assert.ok(existsSync(join(directory, 'quit.json')))
})

test('overlay without a compositor is a NO_SESSION failure', async (t) => {
  const runtime = tempDir('hyprscope-message-empty-')
  const directory = tempDir('hyprscope-message-empty-state-')
  t.after(() => {
    removeDir(runtime)
    removeDir(directory)
  })
  const stderr = sink()
  const env = messageEnv({ XDG_RUNTIME_DIR: runtime, HYPRSCOPE_MESSAGE_DIR: directory })
  const code = await messageMain(['overlay', '--json'], { stdout: sink(), stderr }, env)
  assert.equal(code, 1)
  assert.equal(JSON.parse(stderr.text.trim()).error.code, 'NO_SESSION')
})

test('overlay without a Wayland display is an OVERLAY_FAILED failure', async (t) => {
  const runtimeDir = tempDir('hyprscope-message-no-display-')
  const directory = tempDir('hyprscope-message-no-display-state-')
  const instance = await fakeInstance(runtimeDir, 'sig-no-display', { display: 'wayland-9' })
  t.after(async () => {
    for (const server of instance.servers) await closeServer(server)
    removeDir(runtimeDir)
    removeDir(directory)
  })
  const env = messageEnv({ XDG_RUNTIME_DIR: runtimeDir, HYPRSCOPE_MESSAGE_DIR: directory })
  delete env.WAYLAND_DISPLAY
  const stderr = sink()
  const code = await messageMain(['overlay', '--json'], { stdout: sink(), stderr }, env)
  assert.equal(code, 1)
  const failure = JSON.parse(stderr.text.trim()).error
  assert.equal(failure.code, 'OVERLAY_FAILED')
  assert.match(failure.message, /needs a Wayland display/)
})

test('entry routes the message surface and rejects an unknown subcommand', async () => {
  const help = sink()
  assert.equal(await entryMain(['message', '--help'], { stdout: help, stderr: sink() }), 0)
  assert.match(help.text, /desktop message composer for a running DSH Host/)
  const stderr = sink()
  assert.equal(await entryMain(['message', 'nope'], { stdout: sink(), stderr }), 2)
  assert.match(stderr.text, /Unknown message command/)
})