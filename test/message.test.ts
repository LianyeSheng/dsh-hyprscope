/** Unit tests for the desktop-message CLI surface and its state files. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'

import { main as entryMain } from '../src/entry.ts'
import {
  annotateActiveFile, annotateSessionId, annotateSessionPaths, annotateVoiceResultPath, isAckFile, isActiveFile,
  isAnnotationsFile, isAnnotateSessionId, isSendFile, isSessionFile, isVoiceEventsFile, isVoiceResultFile,
  readActiveFile, readAnnotationsFile, readSessionFile, readVoiceResultFile, relativeTimeMs, writeActiveFile,
  writeAnnotationsFile, writeVoiceResultFile,
} from '../src/message/annotate.ts'
import { MESSAGE_USAGE, main as messageMain, parseMessageArgs } from '../src/message/cli.ts'
import {
  messageDirectory, messagePaths, readShortcutKey, readStatus, statusFresh, writeJsonAtomic, writeOpenRequest,
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
  assert.equal(parseMessageArgs(['annotate', '--json']).command, 'annotate')
  assert.throws(() => parseMessageArgs(['open', '--lang', 'fr']), /--lang expects/)
  assert.throws(() => parseMessageArgs(['open', '--nope']), /Unknown option/)
  assert.match(MESSAGE_USAGE, /annotate/)
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
  assert.equal(request.mode, undefined)
  assert.equal(existsSync(join(directory, 'annotate')), false)
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
  assert.match(stderr.text, /expected open, annotate, overlay or stop/)
})

/**
 * Build a valid session.json document.
 * @returns Session document.
 */
function sessionDocument() {
  return {
    version: 1,
    sessionId: '20261119T162512345Z-a1b2',
    mode: 'annotate',
    startedAt: 1763540712345,
    audioStartedAt: 1763540712380,
    state: 'ready',
    language: 'zh',
    capture: {
      path: '/tmp/capture.png',
      width: 2560,
      height: 1440,
      layoutRect: [0, 0, 1920, 1080],
      monitor: 'DP-1',
      scale: 1.3333,
      transform: 0,
      sha256: 'abc123',
    },
    context: {
      cursor: [812, 503],
      focusedWindow: '0x55d0',
      windows: [{
        id: '0x55d0', class: 'code', title: 'annotate.js', pid: 1234, rect: [0, 0, 1920, 1080],
        workspace: 1, monitor: 'DP-1', focused: true, floating: false,
      }],
      monitors: [{
        name: 'DP-1', rect: [0, 0, 1920, 1080], scale: 1.3333, transform: 0, focused: true, workspace: 1,
      }],
    },
    error: null,
  }
}

test('annotate session identifiers and paths follow the contract', () => {
  const startedAt = Date.UTC(2026, 10, 19, 16, 25, 12, 345)
  const id = annotateSessionId(startedAt, () => 0x1a2b / 0x1_0000)
  assert.equal(id, '20261119T162512345Z-1a2b')
  assert.match(id, /^\d{8}T\d{9}Z-[0-9a-f]{4}$/)
  assert.equal(isAnnotateSessionId(id), true)
  assert.equal(isAnnotateSessionId('20261119T162512345Z'), false)
  assert.equal(isAnnotateSessionId(42), false)
  const paths = annotateSessionPaths('/state/message', id)
  assert.equal(paths.dir, '/state/message/annotate/' + id)
  assert.equal(paths.sessionFile, paths.dir + '/session.json')
  assert.equal(paths.audioFile, paths.dir + '/audio.pcm')
  assert.equal(paths.voiceEventsFile, paths.dir + '/voice-events.json')
  assert.equal(paths.voiceDir, paths.dir + '/voice')
  assert.equal(annotateVoiceResultPath(paths, 'v1'), paths.voiceDir + '/v1.json')
  assert.equal(paths.annotationsFile, paths.dir + '/annotations.json')
  assert.equal(paths.sendFile, paths.dir + '/send.json')
  assert.equal(paths.ackFile, paths.dir + '/ack.json')
  assert.equal(paths.cancelFile, paths.dir + '/cancel.json')
  assert.equal(paths.errorFile, paths.dir + '/error.json')
  assert.equal(annotateActiveFile('/state/message'), '/state/message/annotate/active.json')
  assert.equal(relativeTimeMs(startedAt + 3200, startedAt), 3200)
})

test('annotate validators reject other versions and wrong field types', () => {
  const session = sessionDocument()
  assert.equal(isSessionFile(session), true)
  assert.equal(isSessionFile({ ...session, version: 2 }), false)
  assert.equal(isSessionFile({ ...session, mode: 'composer' }), false)
  assert.equal(isSessionFile({ ...session, context: { ...session.context, cursor: 'nope' } }), false)
  assert.equal(isSessionFile({ ...session, capture: { ...session.capture, scale: '1.3' } }), false)
  assert.equal(isActiveFile({
    version: 1, sessionId: session.sessionId, dir: '/tmp/s', startedAt: 1, audioStartedAt: 2, state: 'ready',
  }), true)
  assert.equal(isActiveFile({ version: 1, sessionId: session.sessionId, dir: '/tmp/s' }), false)
  const annotation = {
    id: 'a1', index: 1, shape: 'rect', from: [420, 180], to: [680, 300],
    atStart: 1763540715560, atEnd: 1763540718200, comment: '这个按钮右边多出来了', windowId: '0x55d0',
  }
  assert.equal(isAnnotationsFile({ version: 1, items: [annotation] }), true)
  assert.equal(isAnnotationsFile({ version: 2, items: [annotation] }), false)
  assert.equal(isAnnotationsFile({ version: 1, items: [{ ...annotation, shape: 'freehand' }] }), false)
  assert.equal(isVoiceEventsFile({
    version: 1,
    segments: [{
      id: 'v1', atStart: 1763540715100, atEnd: 1763540715800,
      anchor: { x: 540, y: 240, windowId: '0x55d0', annotationId: 'a1' },
    }],
  }), true)
  assert.equal(isVoiceEventsFile({ version: 1, segments: [{ id: 'v1', atStart: 1, atEnd: 2, anchor: { x: 'no' } }] }), false)
  assert.equal(isVoiceResultFile({ id: 'v1', text: '你好', seconds: 0.7, error: null }), true)
  assert.equal(isVoiceResultFile({ id: 'v1', text: '你好', seconds: '0.7', error: null }), false)
  assert.equal(isSendFile({
    version: 1, sessionId: session.sessionId, at: 1763540725000, overallNote: '',
    items: [annotation], segments: [{ id: 'v1', text: '这个地方我想你帮我修改一下' }],
  }), true)
  assert.equal(isSendFile({
    version: 1, sessionId: session.sessionId, at: 1763540725000, overallNote: '',
    items: [annotation], segments: [{ id: 'v1', text: 7 }],
  }), false)
  assert.equal(isAckFile({ version: 1, ok: true, message: null, sessionId: 'dsh-session', at: 1763540726500 }), true)
  assert.equal(isAckFile({ version: 1, ok: 'yes', message: null, sessionId: 'dsh-session', at: 1 }), false)
})

test('annotate atomic helpers round-trip valid files and ignore malformed ones', async (t) => {
  const directory = tempDir('hyprscope-annotate-files-')
  t.after(() => removeDir(directory))
  const paths = annotateSessionPaths(directory, '20261119T162512345Z-a1b2')
  mkdirSync(paths.voiceDir, { recursive: true })
  await writeAnnotationsFile(paths, {
    version: 1,
    items: [{
      id: 'a1', index: 1, shape: 'ellipse', from: [10, 20], to: [30, 40],
      atStart: 1, atEnd: 2, comment: '',
    }],
  })
  assert.deepEqual((await readAnnotationsFile(paths))?.items[0]?.to, [30, 40])
  await writeVoiceResultFile(paths, { id: 'v1', text: '你好', seconds: 0.7, error: null })
  assert.equal((await readVoiceResultFile(paths, 'v1'))?.text, '你好')
  await writeActiveFile(directory, {
    version: 1, sessionId: '20261119T162512345Z-a1b2', dir: paths.dir,
    startedAt: 1763540712345, audioStartedAt: 1763540712380, state: 'ready',
  })
  assert.equal((await readActiveFile(directory))?.dir, paths.dir)
  assert.equal(await readSessionFile(paths), null)
  writeFileSync(paths.sessionFile, JSON.stringify({ version: 2, sessionId: 'x' }))
  assert.equal(await readSessionFile(paths), null)
})

test('writeOpenRequest keeps the legacy request and adds an annotate mode', async (t) => {
  const directory = tempDir('hyprscope-message-open-mode-')
  t.after(() => removeDir(directory))
  const paths = messagePaths(directory)
  const legacy = await writeOpenRequest(paths)
  assert.equal(legacy.mode, undefined)
  assert.equal(JSON.parse(readFileSync(paths.openFile, 'utf8')).mode, undefined)
  const annotated = await writeOpenRequest(paths, { mode: 'annotate' })
  assert.equal(annotated.mode, 'annotate')
  assert.equal(JSON.parse(readFileSync(paths.openFile, 'utf8')).mode, 'annotate')
})

test('annotate starts the overlay, requests mode annotate and reports the Host state', async (t) => {
  const runtime = await makeRuntime(t)
  const directory = tempDir('hyprscope-message-annotate-')
  const tools = tempDir('hyprscope-message-annotate-tools-')
  t.after(() => {
    removeDir(directory)
    removeDir(tools)
  })
  writeStatus(directory)
  writeFileSync(join(directory, 'quit.json'), JSON.stringify({ at: new Date().toISOString() }))
  const qs = writeScript(tools, 'quickshell', [
    '#!/bin/sh',
    'printf "%s" "$*" > "$HYPRSCOPE_MESSAGE_DIR/qs-args.txt"',
    'exit 0',
  ].join(String.fromCharCode(10)))
  const env = messageEnv({
    XDG_RUNTIME_DIR: runtime.runtimeDir,
    HYPRSCOPE_MESSAGE_DIR: directory,
    HYPRSCOPE_QUICKSHELL: qs,
  })
  const stdout = sink()
  const stderr = sink()
  const code = await messageMain(['annotate', '--json'], { stdout, stderr }, env)
  assert.equal(code, 0)
  assert.equal(stderr.text, '')
  const value = JSON.parse(stdout.text)
  assert.equal(value.command, 'annotate')
  assert.equal(value.dsh, 'available')
  assert.equal(value.dir, directory)
  assert.equal(typeof value.overlay.pid, 'number')
  assert.equal(value.request.mode, 'annotate')
  const request = JSON.parse(readFileSync(join(directory, 'open.json'), 'utf8'))
  assert.equal(request.nonce, value.request.nonce)
  assert.equal(request.mode, 'annotate')
  assert.equal(existsSync(join(directory, 'annotate')), false)
  assert.equal(existsSync(join(directory, 'quit.json')), false)
})

test('annotate reports an unavailable Host when no heartbeat is fresh', async (t) => {
  const runtime = await makeRuntime(t)
  const directory = tempDir('hyprscope-message-annotate-stale-')
  const tools = tempDir('hyprscope-message-annotate-stale-tools-')
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
  const code = await messageMain(['annotate', '--json'], { stdout, stderr: sink() }, env)
  assert.equal(code, 0)
  const value = JSON.parse(stdout.text)
  assert.equal(value.dsh, 'unavailable')
  assert.equal(JSON.parse(readFileSync(join(directory, 'open.json'), 'utf8')).mode, 'annotate')
})

test('annotate without a compositor is a NO_SESSION failure', async (t) => {
  const runtime = tempDir('hyprscope-message-annotate-no-session-')
  const directory = tempDir('hyprscope-message-annotate-no-session-state-')
  t.after(() => {
    removeDir(runtime)
    removeDir(directory)
  })
  const stderr = sink()
  const env = messageEnv({ XDG_RUNTIME_DIR: runtime, HYPRSCOPE_MESSAGE_DIR: directory })
  const code = await messageMain(['annotate', '--json'], { stdout: sink(), stderr }, env)
  assert.equal(code, 1)
  assert.equal(JSON.parse(stderr.text.trim()).error.code, 'NO_SESSION')
  assert.equal(existsSync(join(directory, 'open.json')), false)
})

test('annotate without a Wayland display is an OVERLAY_FAILED failure and writes no request', async (t) => {
  const runtimeDir = tempDir('hyprscope-message-annotate-no-display-')
  const directory = tempDir('hyprscope-message-annotate-no-display-state-')
  const instance = await fakeInstance(runtimeDir, 'sig-annotate-no-display', { display: 'wayland-9' })
  t.after(async () => {
    for (const server of instance.servers) await closeServer(server)
    removeDir(runtimeDir)
    removeDir(directory)
  })
  const env = messageEnv({ XDG_RUNTIME_DIR: runtimeDir, HYPRSCOPE_MESSAGE_DIR: directory })
  delete env.WAYLAND_DISPLAY
  const stderr = sink()
  const code = await messageMain(['annotate', '--json'], { stdout: sink(), stderr }, env)
  assert.equal(code, 1)
  const failure = JSON.parse(stderr.text.trim()).error
  assert.equal(failure.code, 'OVERLAY_FAILED')
  assert.match(failure.message, /needs a Wayland display/)
  assert.equal(existsSync(join(directory, 'open.json')), false)
})
