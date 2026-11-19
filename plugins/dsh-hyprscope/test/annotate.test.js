/**
 * Unit tests for the annotate bridge's pure pieces.
 *
 * The runner itself needs a compositor, a microphone and a Host Session, so the
 * tests here drive the parts that decide what the agent will read: session
 * identity, monitor and window selection, and the intent card. The card is the
 * product of the whole feature, so its wording, geometry and pairing are
 * asserted directly.
 *
 * Run with: node --test plugins/dsh-hyprscope/test/
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { composeIntentCard, createAnnotateRunner, pickMonitor, sessionIdFor, windowsFor } from '../annotate.js'

/** State snapshot shaped like `hyprscope state --json`. */
function stateFixture() {
  return {
    cursor: { x: 150, y: 40 },
    active: { window: { windowId: '0xcode' } },
    monitors: [
      { name: 'HDMI-A-1', position: { x: 0, y: 0 }, size: { width: 128, height: 100 }, scale: 1, transform: 0, focused: false },
      { name: 'DP-1', position: { x: 128, y: 0 }, size: { width: 256, height: 144 }, scale: 1.5, transform: 0, focused: true },
    ],
    clients: [
      { windowId: '0xcode', app: 'code', title: 'annotate.js', pid: 10, monitor: 1,
        position: { x: 128, y: 0 }, size: { width: 256, height: 144 }, workspace: { id: 1 }, floating: false, mapped: true },
      { windowId: '0xfirefox', app: 'firefox', title: 'arXiv', pid: 11, monitor: 1,
        position: { x: 200, y: 20 }, size: { width: 100, height: 100 }, workspace: { id: 1 }, floating: true, mapped: true },
      { windowId: '0xoffscreen', app: 'term', title: 'hidden', pid: 12, monitor: 0,
        position: { x: 9000, y: 9000 }, size: { width: 100, height: 100 }, workspace: { id: 2 }, floating: false, mapped: true },
    ],
  }
}

/** A session record as the runner would write it. */
function sessionFixture(overrides = {}) {
  return Object.assign({
    id: '20261119T083411625Z-abcd',
    startedAt: 1_000_000,
    capture: {
      path: '/tmp/capture.png',
      width: 384,
      height: 216,
      layoutRect: [128, 0, 256, 144],
      monitor: 'DP-1',
      scale: 1.5,
      transform: 0,
      sha256: 'abc',
    },
    context: {
      cursor: [150, 40],
      focusedWindow: '0xcode',
      windows: [
        { id: '0xcode', class: 'code', title: 'annotate.js', pid: 10, rect: [128, 0, 256, 144], workspace: 1, monitor: 1, focused: true, floating: false },
        { id: '0xfirefox', class: 'firefox', title: 'arXiv', pid: 11, rect: [200, 20, 100, 100], workspace: 1, monitor: 1, focused: false, floating: true },
      ],
      monitors: [],
    },
    language: 'zh',
  }, overrides)
}

/** One annotation in image pixels. */
function annotationFixture() {
  return {
    id: 'a1', index: 1, shape: 'rect', from: [120, 60], to: [240, 120],
    atStart: 1_003_200, atEnd: 1_005_900, comment: '这个按钮右边多出来了', windowId: '0xcode',
  }
}

/** One VAD phrase in absolute milliseconds. */
function phraseFixture() {
  return { id: 'v1.1', atStart: 1_002_800, atEnd: 1_003_500, text: '这个地方我想你帮我修改一下' }
}

test('session ids are compact, sortable and unique enough', () => {
  const id = sessionIdFor(new Date('2026-11-19T08:34:11.625Z'))
  assert.match(id, /^20261119T083411625Z-[0-9a-f]{4}$/)
  assert.notEqual(sessionIdFor(new Date()), sessionIdFor(new Date()))
})

test('the monitor under the pointer wins, then the focused one', () => {
  assert.equal(pickMonitor(stateFixture()).name, 'DP-1')
  const noCursor = stateFixture()
  noCursor.cursor = null
  assert.equal(pickMonitor(noCursor).name, 'DP-1')
  const noFocus = stateFixture()
  noFocus.cursor = null
  noFocus.monitors.forEach(monitor => { monitor.focused = false })
  assert.equal(pickMonitor(noFocus).name, 'HDMI-A-1')
  assert.equal(pickMonitor({}), null)
})

test('window metadata keeps only windows intersecting the capture, bottom to top', () => {
  const windows = windowsFor(stateFixture(), [128, 0, 256, 144], '0xcode')
  assert.deepEqual(windows.map(window => window.id), ['0xcode', '0xfirefox'])
  assert.equal(windows[0].focused, true)
  assert.equal(windows[1].focused, false)
  assert.deepEqual(windows[1].rect, [200, 20, 100, 100])
  assert.equal(windows[1].floating, true)
})

test('window metadata caps the list without dropping the focused window', () => {
  const state = stateFixture()
  state.clients = Array.from({ length: 30 }, (_, index) => ({
    windowId: '0xw' + index, app: 'app', title: 't' + index, pid: 100 + index, monitor: 1,
    position: { x: 128, y: 0 }, size: { width: 256, height: 144 }, workspace: { id: 1 },
    floating: false, mapped: true,
  }))
  const windows = windowsFor(state, [128, 0, 256, 144], '0xw29')
  assert.equal(windows.length, 24)
  assert.equal(windows[windows.length - 1].id, '0xw29')
})

test('the intent card carries geometry, windows, comments and speech links', () => {
  const card = composeIntentCard({
    session: sessionFixture(),
    annotations: [annotationFixture()],
    phrases: [phraseFixture()],
    links: [{ annotationIds: ['a1'], voiceIds: ['v1.1'], confidence: 0.9, source: 'overlap', ambiguous: false }],
    language: 'zh',
    overallNote: '顺便看一下 hover',
    imageAttached: true,
  })
  assert.match(card, /桌面标注/)
  assert.match(card, /截图是干净原图/)
  assert.match(card, /DP-1 256x144 @1.5/)
  assert.match(card, /0xcode code "annotate.js"/)
  assert.match(card, /#1 t=3.2s-5.9s rect image\(120,60\)-\(240,120\)/)
  assert.match(card, /评论：这个按钮右边多出来了/)
  assert.match(card, /语音 v1\.1/)
  assert.match(card, /重叠 300ms/)
  assert.match(card, /置信度 0.9/)
  assert.match(card, /用户补充：顺便看一下 hover/)
})

test('an unbound phrase is reported as a global note', () => {
  const card = composeIntentCard({
    session: sessionFixture(),
    annotations: [annotationFixture()],
    phrases: [phraseFixture()],
    links: [],
    language: 'zh',
    overallNote: '',
    imageAttached: true,
  })
  assert.match(card, /未绑定，按全局备注理解/)
})

test('a missing screenshot is stated in the card and the text stays bounded', () => {
  const long = 'x'.repeat(20_000)
  const card = composeIntentCard({
    session: sessionFixture(),
    annotations: [Object.assign(annotationFixture(), { comment: long })],
    phrases: [phraseFixture()],
    links: [],
    language: 'en',
    overallNote: '',
    imageAttached: false,
  })
  assert.match(card, /exceeded the size limit/)
  assert.ok(card.length <= 8_000)
})

test('the runner ignores composer requests and requests without a nonce', () => {
  const calls = []
  const runner = createAnnotateRunner({
    ctx: { get: () => undefined },
    settings: { messageDir: '/tmp/unused', messageLanguage: 'zh', timeoutMs: 1_000 },
    messagePaths: { dir: '/tmp/unused' },
    runCli: (argv) => { calls.push(argv); return Promise.resolve({ code: 0, stdout: '{}', stderr: '' }) },
    warn: () => {},
    resolveTarget: async () => 'session-1',
    prompt: async () => {},
  })
  runner.handleRequest({ mode: 'composer', nonce: 'n1', at: new Date().toISOString() })
  runner.handleRequest({ mode: 'annotate', at: new Date().toISOString() })
  runner.handleRequest({ mode: 'annotate', nonce: 'stale', at: new Date(Date.now() - 120_000).toISOString() })
  assert.deepEqual(calls, [])
})
/** Wait for a fixed number of milliseconds. */
function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Read a JSON file, or null while it does not exist yet. */
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

test('a full annotate session captures, transcribes and injects one prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyprscope-annotate-'))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const state = {
    cursor: { x: 100, y: 100 },
    active: { window: { windowId: '0xcode' } },
    monitors: [{
      name: 'DP-1', position: { x: 0, y: 0 }, size: { width: 1280, height: 800 },
      scale: 1, transform: 0, focused: true, activeWorkspace: { id: 1 },
    }],
    clients: [{
      windowId: '0xcode', app: 'code', title: 'main.ts', pid: 1, monitor: 0,
      position: { x: 0, y: 0 }, size: { width: 1280, height: 800 }, workspace: { id: 1 },
      floating: false, mapped: true,
    }],
  }
  const calls = []
  const runCli = async (argv) => {
    calls.push(argv)
    if (argv[0] === 'state') return { code: 0, stdout: JSON.stringify(state), stderr: '' }
    if (argv[0] === 'screenshot') {
      const output = argv[argv.indexOf('--output') + 1]
      await writeFile(output, png)
      return { code: 0, stdout: JSON.stringify({ path: output, width: 1280, height: 800, sha256: 'sha' }), stderr: '' }
    }
    throw new Error('unexpected CLI call ' + argv.join(' '))
  }
  const prompts = []
  const speech = {
    resolve: request => ({ audio: request.audio, language: request.language }),
    transcribe: async () => ({ text: '测试语音', audioSeconds: 1, inferenceSeconds: 0.1 }),
  }
  const runner = createAnnotateRunner({
    ctx: { get: name => (name === 'speechToText' ? speech : undefined) },
    settings: { messageDir: dir, messageLanguage: 'zh', timeoutMs: 1_000 },
    messagePaths: { dir },
    runCli,
    warn: () => {},
    resolveTarget: async () => 'sess-1',
    prompt: async (sessionId, content, requestId) => { prompts.push({ sessionId, content, requestId }) },
    recorderStart: async (sessionDir) => {
      const samples = 16_000 * 2
      const pcm = Buffer.alloc(samples * 2)
      for (let index = 0; index < samples; index += 1) {
        const voiced = index >= 6_400 && index < 22_400
        const value = voiced ? Math.round(8_000 * Math.sin(2 * Math.PI * 300 * index / 16_000)) : 0
        pcm.writeInt16LE(value, index * 2)
      }
      await writeFile(join(sessionDir, 'audio.pcm'), pcm)
      return { startedAt: Date.now(), close: async () => {} }
    },
  })
  runner.handleRequest({ mode: 'annotate', nonce: 'n1', at: new Date().toISOString() })
  const activePath = join(dir, 'annotate', 'active.json')
  let active = null
  for (let index = 0; index < 100 && active === null; index += 1) {
    await delay(50)
    active = await readJsonOrNull(activePath)
  }
  assert.ok(active, 'active.json must appear once the session is ready')
  const sessionDir = active.dir
  const session = await readJsonOrNull(join(sessionDir, 'session.json'))
  assert.equal(session.capture.width, 1280)
  assert.equal(session.context.windows.length, 1)
  assert.deepEqual(calls.map(argv => argv[0]), ['state', 'screenshot'])
  const audioStartedAt = session.audioStartedAt
  await writeFile(join(sessionDir, 'voice-events.json'), JSON.stringify({
    version: 1,
    segments: [{ id: 'v1', atStart: audioStartedAt + 400, atEnd: audioStartedAt + 1_400,
      anchor: { x: 10, y: 10, annotationId: 'a1' } }],
  }))
  let voice = null
  for (let index = 0; index < 100 && voice === null; index += 1) {
    await delay(50)
    voice = await readJsonOrNull(join(sessionDir, 'voice', 'v1.json'))
  }
  assert.ok(voice, 'voice result must appear')
  assert.match(voice.text, /测试语音/)
  await writeFile(join(sessionDir, 'send.json'), JSON.stringify({
    version: 1, sessionId: active.sessionId, at: Date.now(), overallNote: '补充',
    items: [{
      id: 'a1', index: 1, shape: 'rect', from: [10, 10], to: [110, 60],
      atStart: audioStartedAt + 300, atEnd: audioStartedAt + 900, comment: '这里', windowId: '0xcode',
    }],
    segments: [{ id: 'v1', text: '测试语音', annotationId: 'a1' }],
  }))
  let ack = null
  for (let index = 0; index < 100 && ack === null; index += 1) {
    await delay(50)
    ack = await readJsonOrNull(join(sessionDir, 'ack.json'))
  }
  assert.ok(ack, 'ack must appear')
  assert.equal(ack.ok, true)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'sess-1')
  assert.match(prompts[0].content[0].text, /桌面标注/)
  assert.match(prompts[0].content[0].text, /这里/)
  assert.match(prompts[0].content[0].text, /测试语音/)
  assert.equal(prompts[0].content[1].type, 'image')
  await delay(300)
  assert.equal(existsSync(activePath), false)
  await runner.dispose()
  rmSync(dir, { recursive: true, force: true })
})
test('a profile without speech-to-text still carries the session and reports the voice error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyprscope-annotate-nospeech-'))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const state = {
    cursor: { x: 10, y: 10 },
    active: { window: { windowId: '0xa' } },
    monitors: [{ name: 'DP-1', position: { x: 0, y: 0 }, size: { width: 640, height: 480 },
      scale: 1, transform: 0, focused: true, activeWorkspace: { id: 1 } }],
    clients: [],
  }
  const runCli = async (argv) => {
    if (argv[0] === 'state') return { code: 0, stdout: JSON.stringify(state), stderr: '' }
    const output = argv[argv.indexOf('--output') + 1]
    await writeFile(output, png)
    return { code: 0, stdout: JSON.stringify({ path: output, width: 640, height: 480, sha256: 's' }), stderr: '' }
  }
  const runner = createAnnotateRunner({
    ctx: { get: () => undefined },
    settings: { messageDir: dir, messageLanguage: 'zh', timeoutMs: 1_000 },
    messagePaths: { dir },
    runCli,
    warn: () => {},
    resolveTarget: async () => 'sess-2',
    prompt: async () => {},
    recorderStart: async (sessionDir) => {
      await writeFile(join(sessionDir, 'audio.pcm'), Buffer.alloc(64_000))
      return { startedAt: Date.now(), close: async () => {} }
    },
  })
  runner.handleRequest({ mode: 'annotate', nonce: 'n2', at: new Date().toISOString() })
  let active = null
  for (let index = 0; index < 100 && active === null; index += 1) {
    await delay(50)
    active = await readJsonOrNull(join(dir, 'annotate', 'active.json'))
  }
  assert.ok(active, 'the session must start without speech-to-text')
  await writeFile(join(active.dir, 'voice-events.json'), JSON.stringify({
    version: 1,
    segments: [{ id: 'v2', atStart: Date.now() + 100, atEnd: Date.now() + 500 }],
  }))
  let voice = null
  for (let index = 0; index < 100 && voice === null; index += 1) {
    await delay(50)
    voice = await readJsonOrNull(join(active.dir, 'voice', 'v2.json'))
  }
  assert.ok(voice, 'the failed voice result is still written')
  assert.match(voice.error, /speech-to-text is not available/)
  await writeFile(join(active.dir, 'cancel.json'), JSON.stringify({ version: 1, at: Date.now() }))
  await delay(300)
  await runner.dispose()
  rmSync(dir, { recursive: true, force: true })
})
