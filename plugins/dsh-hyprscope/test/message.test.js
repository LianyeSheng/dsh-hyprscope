/**
 * Unit tests for the desktop-message bridge in the DSH Host bundle.
 *
 * The bridge runs against a fake \`bin/hyprscope.ts\` in a temporary project: the
 * CLI is a separate executable in production, so its argv, environment and
 * return value are the contract exercised here. The fake writes a recorded-call
 * log and, for the overlay and the screenshot, behaves like the real CLI. No
 * Hyprland session and no Quickshell process is involved.
 *
 * Run with: node --test plugins/dsh-hyprscope/test/
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

/** A valid 1x1 PNG used as the fake screenshot. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** The fake CLI: record one call, then behave like the pieces the bridge uses. */
const NL = String.fromCharCode(10)

/** The fake CLI: record one call, then behave like the pieces the bridge uses. */
const FAKE_CLI = [
  "'use strict'",
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const NL = String.fromCharCode(10)",
  "const root = process.cwd()",
  "const argv = process.argv.slice(2)",
  "fs.appendFileSync(path.join(root, '_calls.jsonl'),",
  "  JSON.stringify({ argv: argv, messageDir: process.env.HYPRSCOPE_MESSAGE_DIR || null }) + NL)",
  "let mode = {}",
  "try { mode = JSON.parse(fs.readFileSync(path.join(root, '_mode.json'), 'utf8')) } catch (error) {}",
  "if (argv[0] === 'message' && argv[1] === 'overlay') {",
  "  if (mode.overlayFailure) { process.stderr.write('no Hyprland session'); process.exit(1) }",
  "  process.stdout.write(JSON.stringify({ command: 'overlay', overlay: mode.overlayPid === undefined ? null : { pid: mode.overlayPid } }) + NL)",
  "  process.exit(0)",
  "}",
  "if (argv[0] === 'message' && argv[1] === 'stop') {",
  "  process.stdout.write('{}' + NL)",
  "  process.exit(0)",
  "}",
  "if (argv[0] === 'screenshot') {",
  "  if (mode.captureFailure) { process.stderr.write('capture failed'); process.exit(1) }",
  "  const at = argv.indexOf('--output')",
  "  const output = at >= 0 ? argv[at + 1] : path.join(root, 'shot.png')",
  "  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')",
  "  fs.writeFileSync(output, png)",
  "  process.stdout.write(JSON.stringify({ path: output, width: 1, height: 1, bytes: png.length }) + NL)",
  "  process.exit(0)",
  "}",
  "process.stdout.write('{}' + NL)",
  "process.exit(0)",
].join(NL)

/**
 * Create a temporary directory owned by the test.
 * @param {import('node:test').TestContext} t Test context.
 * @param {string} prefix Directory prefix.
 * @returns {string} Absolute path.
 */
function makeDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/**
 * Wait until a predicate holds, polling the event loop.
 * @param {() => boolean | Promise<boolean>} predicate Condition.
 * @param {string} label Failure label.
 * @param {number} [timeoutMs] Deadline.
 */
async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => { setTimeout(resolve, 20) })
  }
  throw new Error('timed out waiting for ' + label)
}

/**
 * Build a fake Host context that exposes one session controller.
 * @param {object} options Fixture options.
 * @returns {object} Fake context plus observation handles.
 */
function makeContext(options = {}) {
  const listeners = new Map()
  const disposers = []
  const controller = options.controller ?? makeController(options)
  const ctx = {
    tools: {
      register() { return () => {} },
    },
    get(serviceName) {
      return serviceName === 'sessionController' ? controller : undefined
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { warn() {} },
  }
  return { ctx, controller, listeners, disposers }
}

/**
 * Build a fake session controller that records every prompt.
 * @param {object} options Behaviour switches.
 * @returns {object} Controller plus recorded calls.
 */
function makeController(options = {}) {
  const calls = { prompts: [], lists: 0, creates: 0 }
  const promptFailures = options.promptFailures ?? 0
  const listItems = options.listItems ?? [{ sessionId: 'session-listed' }]
  const createdId = options.createdId ?? 'session-created'
  return {
    calls,
    async prompt(request) {
      calls.prompts.push(request)
      if (promptFailures >= calls.prompts.length) throw new Error('prompt refused')
    },
    async list() {
      calls.lists += 1
      return { items: listItems }
    },
    async create() {
      calls.creates += 1
      return { sessionId: createdId }
    },
  }
}

/**
 * Start the plugin with a fake context and fake CLI, then wait for its status.
 * @param {import('node:test').TestContext} t Test context.
 * @param {object} options Fixture options.
 * @returns {Promise<object>} Harness handles.
 */
async function startBridge(t, options = {}) {
  const projectDir = makeDirectory(t, 'dsh-hyprscope-message-project-')
  const messageDir = makeDirectory(t, 'dsh-hyprscope-message-state-')
  const screenshotDir = makeDirectory(t, 'dsh-hyprscope-message-shots-')
  mkdirSync(join(projectDir, 'bin'), { recursive: true })
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8')
  writeFileSync(join(projectDir, 'bin', 'hyprscope.ts'), FAKE_CLI, 'utf8')
  if (options.mode !== undefined) {
    writeFileSync(join(projectDir, '_mode.json'), JSON.stringify(options.mode), 'utf8')
  }
  const { ctx, controller, listeners, disposers } = makeContext(options)
  const statusDir = options.useEnvDir === true && process.env.HYPRSCOPE_MESSAGE_DIR !== undefined
    ? process.env.HYPRSCOPE_MESSAGE_DIR
    : messageDir
  apply(ctx, options.useEnvDir === true
    ? { projectDir, screenshotDir, ...(options.config ?? {}) }
    : { projectDir, messageDir, screenshotDir, ...(options.config ?? {}) })
  t.after(async () => {
    for (const dispose of disposers) await dispose()
  })
  await waitFor(() => existsSync(join(statusDir, 'status.json')), 'the first status write')
  if (options.mode === undefined || options.mode.overlayFailure !== true) {
    await waitFor(() => callsOf(projectDir).some(call => call.argv[0] === 'message' && call.argv[1] === 'overlay'),
      'the overlay request')
  }
  return { projectDir, messageDir: statusDir, screenshotDir, ctx, controller, listeners, disposers }
}

/** @param {string} projectDir @returns {Array<object>} Recorded CLI calls. */
function callsOf(projectDir) {
  const file = join(projectDir, '_calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(NL).filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/** @param {string} directory @returns {object} Parsed status record. */
function readStatus(directory) {
  return JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))
}

/**
 * Write one composed message into the outbox.
 * @param {string} directory Message directory.
 * @param {object} message Message document.
 */
function compose(directory, message) {
  mkdirSync(join(directory, 'outbox'), { recursive: true })
  writeFileSync(join(directory, 'outbox', 'msg-' + message.id + '.json'), JSON.stringify(message), 'utf8')
}

/** @param {string} directory @returns {object} Parsed acknowledgement. */
function readAck(directory) {
  return JSON.parse(readFileSync(join(directory, 'ack.json'), 'utf8'))
}

test('activation starts the overlay, writes a fresh status and creates the outbox', async (t) => {
  const fixture = await startBridge(t)
  const status = readStatus(fixture.messageDir)
  assert.equal(status.version, 1)
  assert.equal(status.alive, true)
  assert.equal(status.language, 'zh')
  assert.equal(status.attachScreenshot, true)
  assert.equal(typeof status.pid, 'number')
  assert.ok(existsSync(join(fixture.messageDir, 'outbox')))
  const overlay = callsOf(fixture.projectDir).find(call => call.argv[0] === 'message' && call.argv[1] === 'overlay')
  assert.ok(overlay !== undefined, 'the overlay was requested')
  assert.equal(overlay.argv.slice(0, 4).join(' '), 'message overlay --lang zh')
  assert.equal(overlay.messageDir, fixture.messageDir)
})

test('a composed message becomes a queued prompt with an inline screenshot', async (t) => {
  const fixture = await startBridge(t)
  compose(fixture.messageDir, {
    id: 'm1',
    text: 'write a function that sorts the files',
    at: new Date().toISOString(),
  })
  await waitFor(() => fixture.controller.calls.prompts.length === 1, 'the prompt')
  const request = fixture.controller.calls.prompts[0]
  assert.equal(request.sessionId, 'session-listed')
  assert.equal(request.mode, 'queue')
  assert.equal(request.requestId, 'desktop-m1')
  assert.equal(request.content[0].type, 'text')
  assert.equal(request.content[0].text, 'write a function that sorts the files')
  assert.equal(request.content[1].type, 'image')
  assert.equal(request.content[1].mediaType, 'image/png')
  assert.equal(Buffer.from(request.content[1].data, 'base64').equals(PNG), true)
  const screenshot = callsOf(fixture.projectDir).find(call => call.argv[0] === 'screenshot')
  assert.ok(screenshot !== undefined)
  assert.equal(screenshot.messageDir, fixture.messageDir)
  await waitFor(() => existsSync(join(fixture.messageDir, 'ack.json')), 'the acknowledgement')
  const ack = readAck(fixture.messageDir)
  assert.equal(ack.id, 'm1')
  assert.equal(ack.ok, true)
  assert.equal(ack.sessionId, 'session-listed')
  assert.equal(existsSync(join(fixture.messageDir, 'outbox', 'msg-m1.json')), false)
  const status = readStatus(fixture.messageDir)
  assert.equal(status.sessionId, 'session-listed')
})

test('the last root session wins and a subagent session never becomes the target', async (t) => {
  const fixture = await startBridge(t)
  const emit = fixture.listeners.get('session/event')
  assert.equal(typeof emit, 'function')
  emit({ header: { id: 'session-sub', origin: 'subagent' } })
  emit({ header: { id: 'session-root-1' } })
  emit({ header: { id: 'session-root-2' } })
  await waitFor(() => existsSync(join(fixture.messageDir, 'last-session.json')), 'the remembered session')
  const remembered = JSON.parse(readFileSync(join(fixture.messageDir, 'last-session.json'), 'utf8'))
  assert.equal(remembered.sessionId, 'session-root-2')
  compose(fixture.messageDir, { id: 'm2', text: 'hi', at: new Date().toISOString() })
  await waitFor(() => fixture.controller.calls.prompts.length === 1, 'the prompt')
  assert.equal(fixture.controller.calls.prompts[0].sessionId, 'session-root-2')
  assert.equal(fixture.controller.calls.lists, 0)
})

test('an image the route refuses is retried text-only on a refreshed session', async (t) => {
  const fixture = await startBridge(t, { promptFailures: 1, listItems: [{ sessionId: 'session-other' }] })
  compose(fixture.messageDir, { id: 'm3', text: 'what is on screen?', at: new Date().toISOString() })
  await waitFor(() => fixture.controller.calls.prompts.length === 2, 'the text-only retry')
  const [first, second] = fixture.controller.calls.prompts
  assert.equal(first.content.length, 2)
  assert.equal(second.content.length, 1)
  assert.equal(second.sessionId, 'session-other')
  await waitFor(() => existsSync(join(fixture.messageDir, 'ack.json')), 'the acknowledgement')
  const ack = readAck(fixture.messageDir)
  assert.equal(ack.ok, true)
  assert.equal(ack.message, 'sent without the desktop screenshot')
})

test('a prompt that keeps failing is acknowledged as an error', async (t) => {
  const fixture = await startBridge(t, { promptFailures: 99 })
  compose(fixture.messageDir, { id: 'm4', text: 'nobody will read this', at: new Date().toISOString() })
  await waitFor(() => existsSync(join(fixture.messageDir, 'ack.json')), 'the error acknowledgement')
  const ack = readAck(fixture.messageDir)
  assert.equal(ack.id, 'm4')
  assert.equal(ack.ok, false)
  assert.match(ack.message, /prompt refused/)
})

test('disabling screenshot attachment skips the capture and sends text only', async (t) => {
  const fixture = await startBridge(t, { config: { messageAttachScreenshot: false } })
  const status = readStatus(fixture.messageDir)
  assert.equal(status.attachScreenshot, false)
  compose(fixture.messageDir, { id: 'm5', text: 'text only', at: new Date().toISOString() })
  await waitFor(() => fixture.controller.calls.prompts.length === 1, 'the prompt')
  assert.equal(fixture.controller.calls.prompts[0].content.length, 1)
  assert.equal(callsOf(fixture.projectDir).some(call => call.argv[0] === 'screenshot'), false)
})

test('the bridge is off without a session controller and when disabled by config', async (t) => {
  const projectDir = makeDirectory(t, 'dsh-hyprscope-message-project-off-')
  const messageDir = makeDirectory(t, 'dsh-hyprscope-message-state-off-')
  const screenshotDir = makeDirectory(t, 'dsh-hyprscope-message-shots-off-')
  const disabled = makeContext()
  apply(disabled.ctx, { projectDir, messageDir, screenshotDir, desktopMessage: false })
  await new Promise(resolve => { setTimeout(resolve, 100) })
  assert.equal(existsSync(join(messageDir, 'status.json')), false)

  const ctx = {
    tools: { register() { return () => {} } },
    get() { return undefined },
  }
  apply(ctx, { projectDir, messageDir, screenshotDir })
  await new Promise(resolve => { setTimeout(resolve, 100) })
  assert.equal(existsSync(join(messageDir, 'status.json')), false)
})

test('a failed overlay start is retried and reported while tools stay usable', async (t) => {
  const fixture = await startBridge(t, { mode: { overlayFailure: true } })
  await waitFor(() => callsOf(fixture.projectDir).some(call => call.argv[0] === 'message' && call.argv[1] === 'overlay'),
    'the overlay attempt')
  await waitFor(() => readStatus(fixture.messageDir).error !== null, 'the recorded overlay error')
  assert.match(readStatus(fixture.messageDir).error, /cannot start the desktop-message overlay/)
})

test('disposal reports the Host as gone and asks the overlay to exit', async (t) => {
  const fixture = await startBridge(t)
  for (const dispose of fixture.disposers) await dispose()
  const status = readStatus(fixture.messageDir)
  assert.equal(status.alive, false)
  await waitFor(() => callsOf(fixture.projectDir).some(call => call.argv[0] === 'message' && call.argv[1] === 'stop'),
    'the overlay stop request')
})
test('a pinned session is never replaced by the text-only retry', async (t) => {
  const fixture = await startBridge(t, {
    promptFailures: 1,
    listItems: [{ sessionId: 'session-other' }],
    config: { messageSessionId: 'session-pinned' },
  })
  compose(fixture.messageDir, { id: 'm6', text: 'stay here', at: new Date().toISOString() })
  await waitFor(() => fixture.controller.calls.prompts.length === 2, 'the text-only retry')
  assert.equal(fixture.controller.calls.prompts[0].sessionId, 'session-pinned')
  assert.equal(fixture.controller.calls.prompts[1].sessionId, 'session-pinned')
  assert.equal(fixture.controller.calls.lists, 0)
  await waitFor(() => existsSync(join(fixture.messageDir, 'ack.json')), 'the acknowledgement')
  assert.equal(readAck(fixture.messageDir).ok, true)
})
test('the list fallback skips subagent sessions', async (t) => {
  const fixture = await startBridge(t, {
    listItems: [{ sessionId: 'session-sub', origin: 'subagent' }, { sessionId: 'session-visible' }],
  })
  compose(fixture.messageDir, { id: 'm7', text: 'which screen?', at: new Date().toISOString() })
  await waitFor(() => fixture.controller.calls.prompts.length === 1, 'the prompt')
  assert.equal(fixture.controller.calls.prompts[0].sessionId, 'session-visible')
})
test('a custom HYPRSCOPE_MESSAGE_DIR is the fallback when config.messageDir is unset', async (t) => {
  const envDir = makeDirectory(t, 'dsh-hyprscope-message-env-')
  const previous = process.env.HYPRSCOPE_MESSAGE_DIR
  process.env.HYPRSCOPE_MESSAGE_DIR = envDir
  t.after(() => {
    if (previous === undefined) delete process.env.HYPRSCOPE_MESSAGE_DIR
    else process.env.HYPRSCOPE_MESSAGE_DIR = previous
  })
  const fixture = await startBridge(t, { useEnvDir: true })
  assert.ok(existsSync(join(envDir, 'status.json')))
  assert.equal(readStatus(fixture.messageDir).alive, true)
})

test('an overlay that exits right after spawn is reported and retried', async (t) => {
  const fixture = await startBridge(t, { mode: { overlayPid: 999999 } })
  await waitFor(() => readStatus(fixture.messageDir).error !== null, 'the overlay death error', 5_000)
  assert.match(readStatus(fixture.messageDir).error, /exited right after it started/)
})
test('the bridge starts when the session controller appears after activation', async (t) => {
  const projectDir = makeDirectory(t, 'dsh-hyprscope-message-late-project-')
  const messageDir = makeDirectory(t, 'dsh-hyprscope-message-late-state-')
  const screenshotDir = makeDirectory(t, 'dsh-hyprscope-message-late-shots-')
  mkdirSync(join(projectDir, 'bin'), { recursive: true })
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8')
  writeFileSync(join(projectDir, 'bin', 'hyprscope.ts'), FAKE_CLI, 'utf8')
  let controller
  const waiters = []
  const disposers = []
  const ctx = {
    tools: { register() { return () => {} } },
    get() { return controller },
    inject(names, callback) {
      if (names.includes('sessionController')) {
        waiters.push(() => callback({ get() { return controller } }))
      }
      return () => {}
    },
    on() { return () => {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { warn() {} },
  }
  apply(ctx, { projectDir, messageDir, screenshotDir })
  await new Promise(resolve => { setTimeout(resolve, 100) })
  assert.equal(existsSync(join(messageDir, 'status.json')), false)
  assert.equal(waiters.length, 1)
  controller = makeController()
  for (const waiter of waiters) waiter()
  t.after(async () => {
    for (const dispose of disposers) await dispose()
  })
  await waitFor(() => existsSync(join(messageDir, 'status.json')), 'the delayed bridge start')
  const status = readStatus(messageDir)
  assert.equal(status.alive, true)
})
