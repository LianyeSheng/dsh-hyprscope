/**
 * Unit tests for the DSH hyprscope Host bundle.
 *
 * The plugin is driven through a fake Cordis context and a fake
 * `bin/hyprscope.ts` in a temporary project directory: the fake CLI records the
 * argv it received and prints canned JSON/JSONL or failure envelopes selected
 * by `_mode.json`, so the tests can assert the exact command mapping, the
 * canonical parsed value, the render compaction, and every error path without a
 * Hyprland session.
 *
 * Run with: node --test plugins/dsh-hyprscope/test/
 */

import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import * as plugin from '../index.js'

// ---------------------------------------------------------------------------
// Constants and fixtures

/** Exactly the tools the bundle must register. */
const TOOL_NAMES = [
  'hyprscope_observe',
  'hyprscope_screenshot',
  'hyprscope_events',
  'hyprscope_plan',
  'hyprscope_baseline',
  'hyprscope_desktop',
]

/** Tool names whose calls are read-only and therefore concurrency safe. */
const READ_ONLY_TOOLS = ['hyprscope_observe', 'hyprscope_screenshot', 'hyprscope_events']

/** Tool names that must omit isConcurrencySafe (default exclusive). */
const EXCLUSIVE_TOOLS = ['hyprscope_plan', 'hyprscope_baseline', 'hyprscope_desktop']

/** A valid 1x1 PNG (70 bytes) written by the fake CLI for screenshot calls. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * Fake CLI installed as `<projectDir>/bin/hyprscope.ts`. It is plain JavaScript
 * (Node strips the `.ts` extension); it records every invocation to
 * `_argv.jsonl` and returns canned responses selected by `_mode.json`:
 *
 * - `{ stdout }`            override stdout with an exact string
 * - `{ error: {...} }`      exit 1 with `{"error":{...}}` on stderr
 * - `{ mode: 'usage' }`     exit 2 with plain-text stderr
 * - `{ mode: 'plain-error'}` exit 1 with plain-text stderr
 * - `{ sleepMs }`           sleep before exiting (for the timeout test)
 * - `{ events }`            JSONL payload for `events`
 *
 * `control run -` follows the stdin contract: it reads exactly one UTF-8 JSON
 * document from stdin up to EOF and echoes it back as `submittedPlan`, with
 * `stdinBytes`/`stdinEof` evidence; a plan file path is read from disk instead.
 */
const FAKE_CLI = String.raw`'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const projectDir = process.cwd()
const argv = process.argv.slice(2)

function readMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, '_mode.json'), 'utf8'))
  } catch (error) {
    return {}
  }
}

const mode = readMode()

function logCall() {
  try {
    fs.appendFileSync(path.join(projectDir, '_argv.jsonl'), JSON.stringify({ argv: argv, cwd: projectDir }) + '\n')
  } catch (error) {
    // The argv log is test instrumentation; a failure must not mask the response.
  }
}

function valueAfter(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function captureResult(outputPath) {
  fs.writeFileSync(outputPath, PNG_BYTES)
  const monitor = valueAfter('--monitor')
  const region = valueAfter('--region')
  const windowId = valueAfter('--window-id')
  const windowApp = valueAfter('--window-app')
  const windowTitle = valueAfter('--window-title')
  const selector = windowId !== undefined
    ? { field: 'identifier', value: windowId }
    : (windowApp !== undefined
      ? { field: 'appId', value: windowApp }
      : (windowTitle !== undefined ? { field: 'title', value: windowTitle } : undefined))
  const window = selector === undefined ? null : {
    identifier: selector.field === 'identifier' ? selector.value : '180001c6',
    appId: selector.field === 'appId' ? selector.value : 'kitty',
    title: selector.field === 'title' ? selector.value : 'shell',
  }
  return {
    path: outputPath,
    bytes: PNG_BYTES.length,
    width: 1,
    height: 1,
    sha256: crypto.createHash('sha256').update(PNG_BYTES).digest('hex'),
    capturedAt: '2026-01-02T03:04:05.000Z',
    source: {
      monitor: monitor === undefined ? null : monitor,
      region: region === undefined ? null : {
        x: Number(region.split(',')[0]),
        y: Number(region.split(',')[1]),
        width: Number(region.split(',')[2]),
        height: Number(region.split(',')[3]),
      },
      scope: window !== null ? 'window' : (monitor !== undefined ? 'monitor' : (region !== undefined ? 'region' : 'layout')),
      window: window,
    },
  }
}

function controlResponse(subcommand) {
  if (subcommand === 'request') {
    return {
      leaseId: 'lease-test-1',
      state: 'active',
      target: valueAfter('--desktop') === undefined ? 'user' : valueAfter('--desktop'),
      reason: valueAfter('--reason') === undefined ? null : valueAfter('--reason'),
      ttlSec: valueAfter('--ttl') === undefined ? null : Number(valueAfter('--ttl')),
      consentSec: valueAfter('--consent') === undefined ? null : Number(valueAfter('--consent')),
      approvedAt: '2026-01-02T03:04:05.000Z',
    }
  }
  if (subcommand === 'status') {
    return { state: 'none', leaseId: null, target: 'user', acquiredAt: null, expiresAt: null }
  }
  if (subcommand === 'done' || subcommand === 'panic') {
    return { ok: true, state: 'released' }
  }
  if (subcommand === 'run') {
    // stdin contract: "control run -" reads exactly one UTF-8 JSON document up
    // to EOF. readFileSync(0) only returns once the plugin ends the pipe, so a
    // successful response is also proof of EOF handling.
    const planTarget = argv[2]
    let planFileContent = null
    let submittedPlan = null
    let stdinBytes = 0
    let stdinEof = false
    if (planTarget === '-') {
      let raw = ''
      try {
        raw = fs.readFileSync(0, 'utf8')
        stdinEof = true
      } catch (error) {
        raw = ''
      }
      stdinBytes = Buffer.byteLength(raw, 'utf8')
      try {
        submittedPlan = JSON.parse(raw)
      } catch (error) {
        submittedPlan = null
      }
    } else {
      try {
        planFileContent = fs.readFileSync(planTarget, 'utf8')
      } catch (error) {
        planFileContent = null
      }
    }
    if (argv.indexOf('--dry-run') !== -1) {
      return {
        ok: true,
        summary: { version: 1, steps: 1, kinds: { 'window.focus': 1 } },
        plan: { version: 1, steps: [{ kind: 'window.focus' }] },
        canonical: { version: 1 },
        target: { kind: 'user', signature: 'sig-1' },
        baseline: { present: true, state: 'accepted' },
        staleness: { verdict: 'fresh', reasons: [] },
        planFileContent: planFileContent,
        submittedPlan: submittedPlan,
        stdinBytes: stdinBytes,
        stdinEof: stdinEof,
      }
    }
    return {
      status: 'completed',
      runId: 'run-test-1',
      dir: path.join(projectDir, 'out', 'runs', 'run-test-1'),
      durationMs: 1234,
      target: { kind: 'user', signature: 'sig-1' },
      baseline: { present: true, state: 'accepted' },
      fault: null,
      attempts: [{ attempt: 1, status: 'completed', steps: 1 }],
      steps: [{ kind: 'window.focus', status: 'done' }],
      screenshots: [{ path: path.join(projectDir, 'out', 'shot-1.png') }],
      planFileContent: planFileContent,
      submittedPlan: submittedPlan,
      stdinBytes: stdinBytes,
      stdinEof: stdinEof,
    }
  }
  if (subcommand === 'baseline') {
    if (argv.indexOf('--show') !== -1) {
      return {
        state: 'accepted',
        present: true,
        approvedAt: '2026-01-02T03:04:05.000Z',
        target: 'user',
        effective: ['dispatch.window.move'],
        degraded: [],
        missingRequired: [],
        warnings: [],
        pending: null,
      }
    }
    return {
      probeId: 'probe-test-1',
      mode: argv.indexOf('--read-only') === -1 ? 'full' : 'read-only',
      applied: false,
      state: 'accepted',
      supported: [{ id: 'dispatch.window.move', detail: 'pointer and keyboard delivered' }],
      unsupported: [],
      unknown: [],
      evidence: { dir: path.join(projectDir, 'out', 'baseline', 'probe-test-1') },
      diff: { added: [], removed: [], changed: [] },
      warnings: [],
    }
  }
  if (subcommand === 'desktop') {
    const action = argv[2]
    if (action === 'start') {
      return {
        state: 'running',
        target: 'agent',
        signature: 'sig-agent',
        pid: 4242,
        runtimeDir: path.join(projectDir, '.tmp', 'hypr-agent'),
        waylandDisplay: 'wayland-9',
        baseline: { present: false, state: null, file: path.join(projectDir, 'baseline.json') },
        configHash: null,
        detail: null,
      }
    }
    if (action === 'attach') {
      return {
        state: 'running',
        target: 'external',
        signature: valueAfter('--signature') === undefined ? null : valueAfter('--signature'),
        pid: null,
        runtimeDir: valueAfter('--runtime-dir') === undefined ? null : valueAfter('--runtime-dir'),
        waylandDisplay: null,
        baseline: { present: false, state: null, file: path.join(projectDir, 'baseline.json') },
        configHash: null,
        detail: null,
      }
    }
    if (action === 'status') {
      return {
        state: 'none',
        target: null,
        signature: null,
        pid: null,
        runtimeDir: null,
        waylandDisplay: null,
        baseline: { present: false, state: null, file: path.join(projectDir, 'baseline.json') },
        configHash: null,
        detail: null,
      }
    }
    return { state: 'stopped', target: 'agent', signature: 'sig-agent', pid: null, runtimeDir: null }
  }
  return { ok: true }
}

function observationResponse(command) {
  if (command === 'doctor') {
    return {
      readOnly: true,
      discovery: { ok: true, signature: 'sig-1', runtimeDir: '/run/user/1000/hypr/sig-1' },
      compositor: { running: true, backend: 'Wayland', version: '0.40.0' },
      inventory: { monitors: 2, workspaces: 3, clients: 4, layers: 2 },
      target: { kind: 'user', signature: 'sig-1', managed: false },
      capabilities: {
        observation: ['screenshot', 'events', 'clients', 'workspaces', 'monitors', 'layers', 'cursor', 'lockState'],
        action: [],
        wayland: {
          globals: [
            { name: 'wl_compositor', version: 6 },
            { name: 'wl_seat', version: 9 },
            { name: 'zwlr_screencopy_manager_v1', version: 3 },
          ],
          seatCount: 2,
          capabilities: { screencopy: true, seat: true, idleNotify: false },
        },
      },
      baseline: { present: true, state: 'accepted' },
      isolation: { sandbox: false, readOnlyRuntimeDir: false },
      limitations: ['read-only observation only'],
    }
  }
  if (command === 'state') {
    return {
      readOnly: true,
      observedAt: '2026-01-02T03:04:05.000Z',
      compositor: { signature: 'sig-1', version: '0.40.0' },
      active: { client: { address: '0x55', class: 'kitty' }, workspace: { id: 1, name: '1' } },
      monitors: [{ id: 0, name: 'eDP-1', width: 1920, height: 1080 }],
      workspaces: [{ id: 1, name: '1', monitor: 'eDP-1' }],
      clients: [{ address: '0x55', class: 'kitty', title: 'shell', workspace: 1, monitor: 0 }],
      layers: [{ namespace: 'waybar' }],
      lock: { locked: false, source: 'logind' },
    }
  }
  if (command === 'active') {
    return {
      client: { address: '0x55', class: 'kitty', title: 'shell' },
      workspace: { id: 1, name: '1' },
      monitor: { name: 'eDP-1' },
    }
  }
  if (command === 'clients') {
    return [
      { address: '0x55', class: 'kitty', title: 'shell', workspace: 1, monitor: 0 },
      { address: '0x66', class: 'firefox', title: 'docs', workspace: 2, monitor: 1 },
    ]
  }
  if (command === 'workspaces') return [{ id: 1, name: '1' }, { id: 2, name: '2' }]
  if (command === 'monitors') return [{ id: 0, name: 'eDP-1' }, { id: 1, name: 'HDMI-A-1' }]
  if (command === 'layers') return [{ namespace: 'waybar' }, { namespace: 'swaybg' }]
  if (command === 'cursor') return { x: 10, y: 20 }
  return { ok: true }
}

function defaultStdout() {
  const command = argv[0]
  if (command === 'screenshot') {
    return JSON.stringify(captureResult(valueAfter('--output')))
  }
  if (command === 'events') {
    const events = mode.events === undefined
      ? [
        { event: 'openwindow', data: '0x55,workspace 1,class:kitty', raw: 'openwindow>>0x55,workspace 1,class:kitty' },
        { event: 'activewindow', data: 'kitty', raw: 'activewindow>>kitty' },
      ]
      : mode.events
    return events.map(function (event) { return JSON.stringify(event) }).join('\n') + (events.length > 0 ? '\n' : '')
  }
  if (command === 'control') return JSON.stringify(controlResponse(argv[1]))
  return JSON.stringify(observationResponse(command))
}

function main() {
  logCall()
  if (typeof mode.sleepMs === 'number' && mode.sleepMs > 0) {
    setTimeout(function () {
      process.exitCode = typeof mode.exitCode === 'number' ? mode.exitCode : 0
    }, mode.sleepMs)
    return
  }
  let stdout = ''
  const failing = mode.mode === 'usage' || mode.mode === 'plain-error' || mode.error !== undefined
  if (typeof mode.stdout === 'string') stdout = mode.stdout
  else if (!failing) stdout = defaultStdout()
  let stderr = ''
  let exitCode = typeof mode.exitCode === 'number' ? mode.exitCode : 0
  if (mode.mode === 'usage') {
    stderr = typeof mode.stderr === 'string' ? mode.stderr : 'hyprscope: USAGE: Unknown option --bogus\n'
    exitCode = 2
  } else if (mode.mode === 'plain-error') {
    stderr = typeof mode.stderr === 'string' ? mode.stderr : 'hyprscope: COMMAND_FAILED: socket closed\n'
    exitCode = 1
  } else if (mode.error !== undefined) {
    stderr = JSON.stringify({ error: mode.error })
    exitCode = typeof mode.exitCode === 'number' ? mode.exitCode : 1
  } else if (typeof mode.stderr === 'string') {
    stderr = mode.stderr
  }
  if (stdout !== '') process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n')
  if (stderr !== '') process.stderr.write(stderr.endsWith('\n') ? stderr : stderr + '\n')
  process.exitCode = exitCode
}

main()
`

/** Doctor report used by the doctor canonical/render tests. */
const DOCTOR_REPORT = {
  readOnly: true,
  discovery: { ok: true, signature: 'sig-1', runtimeDir: '/run/user/1000/hypr/sig-1' },
  compositor: { running: true, backend: 'Wayland', version: '0.40.0' },
  inventory: { monitors: 2, workspaces: 3, clients: 4, layers: 2 },
  target: { kind: 'user', signature: 'sig-1', managed: false },
  capabilities: {
    observation: ['screenshot', 'events', 'clients', 'workspaces', 'monitors', 'layers', 'cursor', 'lockState'],
    action: [],
    wayland: {
      globals: [
        { name: 'wl_compositor', version: 6 },
        { name: 'wl_seat', version: 9 },
        { name: 'zwlr_screencopy_manager_v1', version: 3 },
      ],
      seatCount: 2,
      capabilities: { screencopy: true, seat: true, idleNotify: false },
    },
  },
  baseline: { present: true, state: 'accepted' },
  isolation: { sandbox: false, readOnlyRuntimeDir: false },
  limitations: ['read-only observation only'],
}

/** The stable doctor sections kept when the report is too long. */
const DOCTOR_SUMMARY_KEYS = [
  'discovery', 'compositor', 'inventory', 'target', 'capabilities', 'baseline', 'isolation', 'limitations',
  'pluginVersion', 'cliPath',
]

/** Version the loaded bundle must report; read from the bundle's own package.json. */
const PLUGIN_PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

/** Canonical active-window value returned by the fake CLI. */
const ACTIVE_VALUE = {
  client: { address: '0x55', class: 'kitty', title: 'shell' },
  workspace: { id: 1, name: '1' },
  monitor: { name: 'eDP-1' },
}

/** Canonical clients collection returned by the fake CLI. */
const CLIENTS_VALUE = [
  { address: '0x55', class: 'kitty', title: 'shell', workspace: 1, monitor: 0 },
  { address: '0x66', class: 'firefox', title: 'docs', workspace: 2, monitor: 1 },
]

/** Canonical state snapshot returned by the fake CLI. */
const STATE_VALUE = {
  readOnly: true,
  observedAt: '2026-01-02T03:04:05.000Z',
  compositor: { signature: 'sig-1', version: '0.40.0' },
  active: { client: { address: '0x55', class: 'kitty' }, workspace: { id: 1, name: '1' } },
  monitors: [{ id: 0, name: 'eDP-1', width: 1920, height: 1080 }],
  workspaces: [{ id: 1, name: '1', monitor: 'eDP-1' }],
  clients: [{ address: '0x55', class: 'kitty', title: 'shell', workspace: 1, monitor: 0 }],
  layers: [{ namespace: 'waybar' }],
  lock: { locked: false, source: 'logind' },
}

/** Exact note the state-summary fallback must carry. */
const STATE_SUMMARY_NOTE =
  'state summary only; call hyprscope_observe with kind clients|workspaces|monitors|layers for the lists'

/** Canonical CaptureResult shape, text-only (no attachment). */
const CAPTURE_VALUE = {
  path: '/tmp/dsh-hyprscope-shot.png',
  bytes: 70,
  width: 1,
  height: 1,
  sha256: 'a'.repeat(64),
  capturedAt: '2026-01-02T03:04:05.000Z',
  source: { monitor: null, region: null, scope: 'layout', window: null },
}

/** Image attachment reference returned by a fake attachment store. */
const IMAGE_REF = { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 70, width: 1, height: 1 }

/** Canonical events value with no events (a timed-out bare read). */
const EMPTY_EVENTS_VALUE = { events: [], count: 0, timedOut: true, timeoutMs: 600 }

/** Canonical events value with two parsed events. */
const EVENTS_VALUE = {
  events: [
    { event: 'openwindow', data: '0x55,workspace 1', raw: 'openwindow>>0x55,workspace 1' },
    { event: 'activewindow', data: 'kitty', raw: 'activewindow>>kitty' },
  ],
  count: 2,
  timedOut: false,
  timeoutMs: 600,
}

// ---------------------------------------------------------------------------
// Fake Cordis context, fake project directory, and invocation helpers

/** Every argv the fake CLI recorded, across all tests (for the argv safety audit). */
const recordedCalls = []

/**
 * Create a temporary project directory with (optionally) the fake CLI.
 * @param {import('node:test').TestContext} t Test context owning cleanup.
 * @param {{ writeCli?: boolean }} [options] Whether to install bin/hyprscope.ts.
 * @returns {string} Absolute project directory.
 */
function makeProject(t, options = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'dsh-hyprscope-plugin-'))
  if (options.writeCli !== false) {
    mkdirSync(join(projectDir, 'bin'), { recursive: true })
    // Pin the fake project to CommonJS: when TMPDIR points inside this
    // repository (AGENTS.md suggests TMPDIR=$PWD/.tmp), the nearest
    // package.json would otherwise be the repo root's `"type": "module"` and
    // the fake CLI's `require(...)` would fail as ESM.
    writeFileSync(join(projectDir, 'package.json'), '{"type":"commonjs"}\n', 'utf8')
    writeFileSync(join(projectDir, 'bin', 'hyprscope.ts'), FAKE_CLI, 'utf8')
  }
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  return projectDir
}

/**
 * Temp entries matching the temp plan-file prefix the plugin used to write.
 * Inline plans must no longer create one; this snapshots the shared temp
 * directory so the assertion can prove nothing new appeared.
 * @returns {string[]} Sorted entry names.
 */
function tempPlanFiles() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-hyprscope-plan-')).sort()
}

/**
 * Build the fake Cordis context: tools.register collects definitions and
 * returns a disposer, get() returns only mounted services, inject() calls back
 * with the same fake context plus an optional systemPrompt service.
 * @param {{ services?: object, promptMode?: string }} [options] Fake services and prompt behaviour.
 * @returns Fake context plus observation handles.
 */
function makeFakeContext(options = {}) {
  const definitions = new Map()
  const registered = []
  const sections = []
  const disposers = []
  const injectCalls = []
  const services = options.services === undefined ? {} : options.services
  const promptMode = options.promptMode === undefined ? 'ok' : options.promptMode
  const systemPrompt = {
    section(entry) {
      if (promptMode === 'section-throws') throw new Error('section name already registered')
      sections.push(entry)
      return () => {}
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        definitions.set(definition.name, definition)
        const dispose = () => definitions.delete(definition.name)
        disposers.push(dispose)
        return dispose
      },
    },
    get(serviceName) {
      return services[serviceName]
    },
  }
  if (promptMode !== 'no-inject') {
    ctx.inject = (names, callback) => {
      injectCalls.push(names)
      if (promptMode === 'inject-throws') throw new Error('inject is unavailable in this context')
      if (promptMode === 'reject') return Promise.reject(new Error('optional service disappeared'))
      return callback({ ...ctx, systemPrompt })
    }
  }
  return { ctx, definitions, registered, sections, disposers, injectCalls, services }
}

/**
 * Build a harness: temporary project + fake CLI + fake context + applied plugin.
 * @param {import('node:test').TestContext} t Test context owning cleanup.
 * @param {object} [options] Harness options.
 * @returns Harness bound to one plugin instance.
 */
function makeHarness(t, options = {}) {
  const projectDir = makeProject(t, { writeCli: options.writeCli })
  const fake = makeFakeContext(options)
  const config = typeof options.config === 'function'
    ? options.config(projectDir)
    : (options.config === undefined ? {} : options.config)
  const harness = {
    projectDir,
    ctx: fake.ctx,
    definitions: fake.definitions,
    registered: fake.registered,
    sections: fake.sections,
    disposers: fake.disposers,
    injectCalls: fake.injectCalls,
    services: fake.services,
    agent: options.agent,
    /** Replace the canned CLI behaviour. */
    setMode(mode) {
      writeFileSync(join(projectDir, '_mode.json'), JSON.stringify(mode === undefined ? {} : mode), 'utf8')
    },
    /** Every recorded CLI invocation for this project. */
    calls() {
      const file = join(projectDir, '_argv.jsonl')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
    },
    /** The most recent recorded invocation, if any. */
    lastCall() {
      const calls = this.calls()
      return calls.length === 0 ? undefined : calls[calls.length - 1]
    },
    /** The most recent recorded argv, if any. */
    lastArgv() {
      const call = this.lastCall()
      return call === undefined ? undefined : call.argv
    },
    /** Apply the plugin with this project's projectDir plus extra config. */
    apply(extraConfig = {}) {
      return plugin.apply(fake.ctx, { projectDir, ...extraConfig })
    },
    /** Invoke one registered tool. */
    execute(name, args, exec) {
      const definition = fake.definitions.get(name)
      assert.ok(definition !== undefined, `tool ${name} is registered`)
      return definition.execute(args, exec === undefined ? execContext(options.agent) : exec)
    },
  }
  if (options.apply !== false) harness.apply(config)
  return harness
}

/** @returns A minimal tool execution context. */
function execContext(agent) {
  return { signal: new AbortController().signal, agent }
}

/**
 * Invoke a tool and archive every argv it caused, so the final audit can prove
 * no tool ever passes the removed `--accept` baseline flag.
 * @param {object} harness Harness under test.
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {object} [exec] Execution context (signal plus optional agent).
 * @returns {Promise<unknown>} Canonical tool value.
 */
async function invoke(harness, name, args, exec) {
  const before = harness.calls().length
  try {
    return await harness.execute(name, args, exec)
  } finally {
    for (const call of harness.calls().slice(before)) recordedCalls.push(call)
  }
}

/** @returns Render blocks for one tool value. */
function renderBlocks(harness, name, args, value) {
  const definition = harness.definitions.get(name)
  assert.ok(definition !== undefined, `tool ${name} is registered`)
  return definition.output.render(args, value)
}

/** @returns The single text block's text; asserts the one-text-block envelope. */
function renderText(harness, name, args, value) {
  const blocks = renderBlocks(harness, name, args, value)
  assert.ok(Array.isArray(blocks), `${name} render must return an array of content blocks`)
  assert.equal(blocks.length, 1, `${name} render must return exactly one text block`)
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof blocks[0].text, 'string')
  return blocks[0].text
}

/** Fake attachment store that records saveImage calls. */
function makeAttachments(options = {}) {
  const calls = []
  return {
    calls,
    async saveImage(input) {
      calls.push(input)
      if (options.error !== undefined) throw options.error
      return options.ref === undefined ? { ...IMAGE_REF } : options.ref
    },
  }
}

/** Fake llm service whose resolveModelInfo records the routed request. */
function makeLlm(inputModalities) {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model, signal) {
      calls.push({ provider, model, signal })
      return { inputModalities }
    },
  }
}

/** Large clients collection used by the array-compaction render test. */
function makeLargeClients(count = 120) {
  return Array.from({ length: count }, (_, index) => ({
    address: `0x${(0x1000 + index).toString(16)}`,
    class: `client-${index}`,
    title: `a long window title for compaction ${index}`.repeat(5),
    workspace: (index % 5) + 1,
    monitor: index % 2,
  }))
}

/** Large state snapshot used by the state-summary render test. */
function makeLargeState() {
  return {
    readOnly: true,
    observedAt: '2026-01-02T03:04:05.000Z',
    compositor: { signature: 'sig-1', version: '0.40.0' },
    active: { client: { address: '0x55', class: 'kitty' }, workspace: { id: 1, name: '1' } },
    monitors: Array.from({ length: 3 }, (_, index) => ({ id: index, name: `Monitor-${index}`, width: 1920, height: 1080 })),
    workspaces: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: String(index + 1), monitor: `Monitor-${index % 3}` })),
    clients: Array.from({ length: 80 }, (_, index) => ({
      address: `0x${(0x2000 + index).toString(16)}`,
      class: `app-${index}`,
      title: `window title ${index}`.repeat(6),
      workspace: (index % 10) + 1,
      monitor: index % 3,
    })),
    layers: [{ namespace: 'waybar' }],
    lock: { locked: false, source: 'logind' },
  }
}

// ---------------------------------------------------------------------------
// Registration and plugin lifecycle

test('the plugin module exposes the Host bundle contract', () => {
  assert.equal(plugin.name, 'dsh-hyprscope')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers exactly the six hyprscope tools and keeps their disposers', (t) => {
  const harness = makeHarness(t)
  assert.deepEqual(harness.registered.map((definition) => definition.name), TOOL_NAMES)
  assert.deepEqual([...harness.definitions.keys()], TOOL_NAMES)
  assert.equal(harness.registered.length, 6)
  assert.equal(harness.disposers.length, 6)
  for (const dispose of harness.disposers) assert.equal(typeof dispose, 'function')
  // The removed tools must not come back: consent belongs to plan run itself.
  for (const removed of ['hyprscope_lease', 'hyprscope_act']) {
    assert.equal(harness.definitions.has(removed), false, `${removed} must not be registered`)
  }
})

test('every tool definition is a raw object with the supported JSON-schema subset', (t) => {
  const harness = makeHarness(t)
  for (const name of TOOL_NAMES) {
    const definition = harness.definitions.get(name)
    assert.equal(definition.name, name)
    assert.match(definition.name, /^[a-z][a-z0-9_]{0,63}$/)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${name} needs a useful description`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.ok(Array.isArray(definition.parameters.required), `${name} required must be an array`)
    assert.equal(typeof definition.parameters.properties, 'object')
    assert.deepEqual(definition.output.schema, { type: 'object', additionalProperties: true })
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }
  // Exact required parameters.
  const requiredByTool = {
    hyprscope_observe: ['kind'],
    hyprscope_screenshot: [],
    hyprscope_events: [],
    hyprscope_plan: ['action'],
    hyprscope_baseline: ['action'],
    hyprscope_desktop: ['action'],
  }
  for (const [name, required] of Object.entries(requiredByTool)) {
    assert.deepEqual(harness.definitions.get(name).parameters.required, required)
  }
  // No tool accepts a consent answer: plan run and baseline probe carry the
  // host's card, and nothing here can approve it.
  for (const name of TOOL_NAMES) {
    assert.equal(Object.hasOwn(harness.definitions.get(name).parameters.properties, 'accept'), false)
  }
})

test('language selects the card and overlay rendering language', async (t) => {
  const harness = makeHarness(t)
  // The agent picks the language per call; the CLI receives it as --lang and
  // renders the consent card in that language.
  await invoke(harness, 'hyprscope_baseline', { action: 'probe', language: 'en' })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'baseline', '--probe', '--consent', '45', '--lang', 'en', '--json',
  ])
  await invoke(harness, 'hyprscope_plan', { action: 'run', plan: { version: 1, steps: [] }, language: 'zh' })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'run', '-', '--consent', '45', '--max-resumes', '1', '--lang', 'zh', '--json',
  ])
  for (const name of ['hyprscope_plan', 'hyprscope_baseline']) {
    const definition = harness.definitions.get(name)
    assert.deepEqual(definition.parameters.properties.language.enum, ['zh', 'en'],
      `${name} exposes the render language enum`)
  }
  // An unknown language fails locally, before any CLI process is spawned.
  const before = harness.calls().length
  await assert.rejects(
    invoke(harness, 'hyprscope_plan', { action: 'validate', plan: { version: 1, steps: [] }, language: 'fr' }),
    /language/,
  )
  assert.equal(harness.calls().length, before)
})

test('only the read-only tools declare isConcurrencySafe', (t) => {
  const harness = makeHarness(t)
  for (const name of READ_ONLY_TOOLS) {
    const definition = harness.definitions.get(name)
    assert.equal(typeof definition.isConcurrencySafe, 'function', `${name} must declare concurrency safety`)
    assert.equal(definition.isConcurrencySafe({}), true)
  }
  for (const name of EXCLUSIVE_TOOLS) {
    assert.equal(Object.hasOwn(harness.definitions.get(name), 'isConcurrencySafe'), false, `${name} must stay exclusive`)
  }
})

test('apply tolerates a null or absent config', () => {
  const fake = makeFakeContext()
  assert.doesNotThrow(() => plugin.apply(fake.ctx, null))
  assert.equal(fake.definitions.size, 6)
  const second = makeFakeContext()
  assert.doesNotThrow(() => plugin.apply(second.ctx))
  assert.equal(second.definitions.size, 6)
})

test('invalid config throws in apply before any tool is registered', (t) => {
  const harness = makeHarness(t, { apply: false })
  assert.throws(() => harness.apply({ timeoutMs: 0 }), /config\.timeoutMs must be an integer between 1 and 86400000/)
  assert.throws(() => harness.apply({ maxRenderChars: 1 }), /config\.maxRenderChars must be an integer between 64 and 1000000/)
  assert.throws(() => harness.apply({ projectDir: 42 }), /config\.projectDir must be a non-empty string/)
  assert.throws(() => harness.apply({ controlTimeoutMs: 0 }), /config\.controlTimeoutMs must be an integer/)
  assert.throws(() => harness.apply({ screenshotDir: '' }), /config\.screenshotDir must be a non-empty string/)
  assert.throws(() => harness.apply({ attachScreenshotImage: 'yes' }), /config\.attachScreenshotImage must be a boolean/)
  assert.throws(() => harness.apply({ nodeExecutable: '' }), /config\.nodeExecutable must be a non-empty string/)
  assert.equal(harness.definitions.size, 0)
})

test('apply registers the hyprscope systemPrompt section when the service is available', (t) => {
  const harness = makeHarness(t)
  assert.deepEqual(harness.injectCalls, [['systemPrompt'], ['sessionController']])
  assert.equal(harness.sections.length, 2)
  const section = harness.sections[0]
  assert.equal(section.name, 'hyprscope')
  assert.equal(section.order, 3050)
  assert.equal(typeof section.text, 'string')
  assert.match(section.text, /Use the hyprscope_\* tools/)
  assert.match(section.text, /hyprscope_plan run/)
  assert.match(section.text, /hyprscope_baseline action "probe"/)
  assert.match(section.text, /There is no separate lease request/)
  assert.doesNotMatch(section.text, /hyprscope_lease/)
  assert.doesNotMatch(section.text, /hyprscope_act/)
  assert.match(section.text, /confirmation card/)
  assert.doesNotMatch(section.text, /action "accept"/)
  assert.match(section.text, /Never approve a consent card/)
})

test('the feedback section asks for a silent reflection and points at the issue forms', (t) => {
  const harness = makeHarness(t)
  const section = harness.sections.find(entry => entry.name === 'hyprscope-feedback')
  assert.ok(section, 'hyprscope-feedback section is registered')
  assert.equal(section.order, 3051)
  assert.match(section.text, /reflect once/)
  assert.match(section.text, /Keep that reflection to yourself/)
  assert.match(section.text, /only if the user asks/)
  assert.match(section.text, /error code/)
  assert.match(section.text, /github\.com\/LianyeSheng\/dsh-hyprscope\/issues/)
  assert.match(section.text, /Do not open an issue yourself/)
  assert.match(section.text, /screenshot of the user/)
})

test('systemPrompt injection failures never break apply', async (t) => {
  const projectDir = makeProject(t)
  for (const promptMode of ['inject-throws', 'section-throws', 'reject', 'no-inject']) {
    const fake = makeFakeContext({ promptMode })
    assert.doesNotThrow(
      () => plugin.apply(fake.ctx, { projectDir }),
      `apply must survive promptMode=${promptMode}`,
    )
    assert.equal(fake.definitions.size, 6, `all tools registered for promptMode=${promptMode}`)
  }
  // Let the rejected optional-service fiber settle without an unhandled rejection.
  await new Promise((resolve) => setImmediate(resolve))
})

test('a missing runnable entry keeps activation but names projectDir on every call', async (t) => {
  const harness = makeHarness(t, { writeCli: false })
  assert.equal(harness.definitions.size, 6)
  await assert.rejects(
    invoke(harness, 'hyprscope_observe', { kind: 'active' }),
    (error) => {
      assert.match(error.message, /hyprscope CLI not found at/)
      assert.ok(error.message.includes(join(harness.projectDir, 'dist', 'bin', 'hyprscope')))
      assert.match(error.message, /projectDir/)
      assert.match(error.message, /bin\/hyprscope\.ts/)
      assert.match(error.message, /bin\/hyprscope\.js/)
      return true
    },
  )
  assert.equal(harness.calls().length, 0)
})

// ---------------------------------------------------------------------------
// hyprscope_observe

test('observe active maps the bare command, --timeout and --json', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ stdout: JSON.stringify(ACTIVE_VALUE) })
  const value = await invoke(harness, 'hyprscope_observe', { kind: 'active' })
  assert.deepEqual(value, ACTIVE_VALUE)
  assert.deepEqual(harness.lastArgv(), ['active', '--timeout', '30000', '--json'])
})

test('observe clients maps --timeout and only passes instance flags when given', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ stdout: JSON.stringify(CLIENTS_VALUE) })
  const value = await invoke(harness, 'hyprscope_observe', {
    kind: 'clients',
    timeoutMs: 1500,
    desktop: 'agent',
    signature: 'sig-1',
    runtimeDir: '/run/user/1000/hypr/sig-1',
  })
  assert.deepEqual(value, CLIENTS_VALUE)
  assert.deepEqual(harness.lastArgv(), [
    'clients',
    '--timeout', '1500',
    '--desktop', 'agent',
    '--signature', 'sig-1',
    '--runtime-dir', '/run/user/1000/hypr/sig-1',
    '--json',
  ])
})

test('observe state maps the bare command and returns the canonical snapshot', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ stdout: JSON.stringify(STATE_VALUE) })
  const value = await invoke(harness, 'hyprscope_observe', { kind: 'state' })
  assert.deepEqual(value, STATE_VALUE)
  assert.deepEqual(harness.lastArgv(), ['state', '--timeout', '30000', '--json'])
})

test('observe collection kinds map to their own bare commands', async (t) => {
  const harness = makeHarness(t)
  for (const kind of ['workspaces', 'monitors', 'layers', 'cursor']) {
    const value = await invoke(harness, 'hyprscope_observe', { kind })
    assert.deepEqual(harness.lastArgv(), [kind, '--timeout', '30000', '--json'])
    if (kind === 'cursor') assert.deepEqual(value, { x: 10, y: 20 })
    else assert.ok(Array.isArray(value))
  }
})

test('observe render keeps a small clients array as compact JSON', (t) => {
  const harness = makeHarness(t)
  const text = renderText(harness, 'hyprscope_observe', { kind: 'clients' }, CLIENTS_VALUE)
  assert.equal(text, JSON.stringify(CLIENTS_VALUE))
})

test('observe render compacts a long clients array with total/returned/omitted', (t) => {
  const harness = makeHarness(t)
  const clients = makeLargeClients()
  const text = renderText(harness, 'hyprscope_observe', { kind: 'clients' }, clients)
  assert.ok(text.length <= 7000, `render must stay under maxRenderChars, got ${text.length}`)
  const compacted = JSON.parse(text)
  assert.equal(compacted.total, clients.length)
  assert.ok(compacted.returned > 0)
  assert.ok(compacted.returned < clients.length)
  assert.equal(compacted.omitted, clients.length - compacted.returned)
  assert.equal(compacted.items.length, compacted.returned)
  assert.deepEqual(compacted.items, clients.slice(0, compacted.returned))
})

test('observe render falls back to the state summary above maxRenderChars', (t) => {
  const harness = makeHarness(t)
  const state = makeLargeState()
  const text = renderText(harness, 'hyprscope_observe', { kind: 'state' }, state)
  assert.ok(text.length <= 7000, `summary must stay under maxRenderChars, got ${text.length}`)
  const summary = JSON.parse(text)
  assert.deepEqual(Object.keys(summary).sort(), ['active', 'compositor', 'counts', 'lock', 'note', 'observedAt', 'readOnly'])
  assert.equal(summary.readOnly, true)
  assert.equal(summary.observedAt, state.observedAt)
  assert.deepEqual(summary.compositor, state.compositor)
  assert.deepEqual(summary.active, state.active)
  assert.deepEqual(summary.lock, state.lock)
  assert.deepEqual(summary.counts, { monitors: 3, workspaces: 10, clients: 80, layers: 1 })
  assert.equal(summary.note, STATE_SUMMARY_NOTE)
})

test('observe doctor adds the loaded pluginVersion and the spawned cliPath', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ stdout: JSON.stringify(DOCTOR_REPORT) })
  const value = await invoke(harness, 'hyprscope_observe', { kind: 'doctor' })
  // The CLI's own report is untouched; the plugin adds two top-level fields.
  assert.equal(value.readOnly, true)
  assert.equal(value.pluginVersion, PLUGIN_PACKAGE_VERSION)
  assert.equal(value.cliPath, join(harness.projectDir, 'bin', 'hyprscope.ts'))
  assert.deepEqual(harness.lastArgv(), ['doctor', '--timeout', '30000', '--json'])
  const text = renderText(harness, 'hyprscope_observe', { kind: 'doctor' }, value)
  const rendered = JSON.parse(text)
  assert.equal(rendered.pluginVersion, PLUGIN_PACKAGE_VERSION)
  assert.equal(rendered.cliPath, value.cliPath)
  // The description tells an agent where the fields live.
  const description = harness.definitions.get('hyprscope_observe').description
  assert.match(description, /pluginVersion/)
  assert.match(description, /cliPath/)
  // Only doctor carries the provenance; other observation kinds stay the CLI's value.
  const active = await invoke(harness, 'hyprscope_observe', { kind: 'active' })
  assert.equal(Object.hasOwn(active, 'pluginVersion'), false)
  assert.equal(Object.hasOwn(active, 'cliPath'), false)
})

test('observe doctor render drops wayland globals while the canonical value keeps them', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ stdout: JSON.stringify(DOCTOR_REPORT) })
  const value = await invoke(harness, 'hyprscope_observe', { kind: 'doctor' })
  assert.equal(value.capabilities.wayland.globals.length, 3)
  const text = renderText(harness, 'hyprscope_observe', { kind: 'doctor' }, value)
  assert.ok(text.length <= 7000)
  const rendered = JSON.parse(text)
  assert.equal(Object.hasOwn(rendered.capabilities.wayland, 'globals'), false)
  assert.deepEqual(rendered.capabilities.wayland, {
    seatCount: 2,
    capabilities: { screencopy: true, seat: true, idleNotify: false },
  })
  assert.deepEqual(rendered.capabilities.observation, DOCTOR_REPORT.capabilities.observation)
  assert.deepEqual(rendered.discovery, DOCTOR_REPORT.discovery)
  assert.deepEqual(rendered.baseline, DOCTOR_REPORT.baseline)
  assert.deepEqual(rendered.limitations, DOCTOR_REPORT.limitations)
  assert.equal(rendered.pluginVersion, PLUGIN_PACKAGE_VERSION)
  assert.equal(rendered.cliPath, value.cliPath)
})

test('observe doctor render keeps only the stable sections when still too long', (t) => {
  const harness = makeHarness(t, { config: { maxRenderChars: 2000 } })
  const doctor = {
    ...DOCTOR_REPORT,
    pluginVersion: PLUGIN_PACKAGE_VERSION,
    cliPath: join(harness.projectDir, 'bin', 'hyprscope.ts'),
    debug: 'x'.repeat(3000),
  }
  // A fresh value is rendered directly; no CLI call is needed for a pure render.
  const text = renderText(harness, 'hyprscope_observe', { kind: 'doctor' }, doctor)
  assert.ok(text.length <= 2000)
  const rendered = JSON.parse(text)
  assert.deepEqual(Object.keys(rendered).sort(), [...DOCTOR_SUMMARY_KEYS].sort())
  assert.equal(rendered.pluginVersion, PLUGIN_PACKAGE_VERSION)
  assert.equal(rendered.cliPath, doctor.cliPath)
  assert.equal(Object.hasOwn(rendered, 'debug'), false)
  assert.equal(Object.hasOwn(rendered.capabilities.wayland, 'globals'), false)
})

// ---------------------------------------------------------------------------
// CLI failure mapping

test('CAPABILITY failures name the baseline probe and its confirmation card', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({
    error: { code: 'CAPABILITY', message: 'baseline is missing', details: { missing: ['dispatch.window.move'] } },
  })
  await assert.rejects(
    invoke(harness, 'hyprscope_plan', { action: 'run', plan: { version: 1, steps: [] } }),
    (error) => {
      assert.match(error.message, /^hyprscope CAPABILITY: baseline is missing/)
      assert.ok(error.message.includes('details: {"missing":["dispatch.window.move"]}'))
      assert.match(error.message, /missing, stale, incomplete or unverified/)
      assert.match(error.message, /hyprscope_baseline with action "probe"/)
      assert.match(error.message, /confirmation card/)
      assert.doesNotMatch(error.message, /action "accept"/)
      return true
    },
  )
  assert.equal(harness.lastArgv().at(-1), '--json')
})

test('LOCKED failures explain the locked screenshot refusal', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ error: { code: 'LOCKED', message: 'The session reports a lock; pass --allow-locked to capture anyway' } })
  const output = join(harness.projectDir, 'locked.png')
  await assert.rejects(
    invoke(harness, 'hyprscope_screenshot', { output }),
    (error) => {
      assert.match(error.message, /^hyprscope LOCKED: The session reports a lock/)
      assert.match(error.message, /screenshots are refused/)
      assert.match(error.message, /allowLocked/)
      return true
    },
  )
  assert.equal(existsSync(output), false)
})

test('NO_SESSION failures explain Hyprland discovery and the selector flags', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ error: { code: 'NO_SESSION', message: 'No Hyprland session found' } })
  await assert.rejects(
    invoke(harness, 'hyprscope_observe', { kind: 'active' }),
    (error) => {
      assert.match(error.message, /^hyprscope NO_SESSION: No Hyprland session found/)
      assert.match(error.message, /Hyprland is running/)
      assert.match(error.message, /signature or runtimeDir/)
      return true
    },
  )
})

test('USAGE exit code 2 maps to a rejected-arguments error with the doctor next step', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ mode: 'usage', stderr: 'hyprscope: USAGE: Unknown option --bogus' })
  await assert.rejects(
    invoke(harness, 'hyprscope_observe', { kind: 'active' }),
    (error) => {
      assert.match(error.message, /^hyprscope rejected the arguments: hyprscope: USAGE: Unknown option --bogus/)
      assert.match(error.message, /hyprscope_observe with kind "doctor"/)
      assert.match(error.message, /pluginVersion and cliPath/)
      assert.match(error.message, /restart DSH/)
      return true
    },
  )
})

test('plain-text exit 1 failures keep the raw reason and add no wrong hint', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ mode: 'plain-error', stderr: 'hyprscope: COMMAND_FAILED: socket closed' })
  await assert.rejects(
    invoke(harness, 'hyprscope_baseline', { action: 'show' }),
    (error) => {
      assert.match(error.message, /^hyprscope failed \(exit 1\): hyprscope: COMMAND_FAILED: socket closed$/)
      assert.doesNotMatch(error.message, /XDG_STATE_HOME/)
      assert.doesNotMatch(error.message, /next step:/)
      return true
    },
  )
})

test('EROFS failures point at XDG_STATE_HOME and the real state home', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({
    mode: 'plain-error',
    stderr: "hyprscope: COMMAND_FAILED: EROFS: read-only file system, mkdir '/home/user/.local/state/hyprlease'",
  })
  await assert.rejects(
    invoke(harness, 'hyprscope_baseline', { action: 'show' }),
    (error) => {
      assert.match(error.message, /^hyprscope failed \(exit 1\): hyprscope: COMMAND_FAILED: EROFS/)
      assert.match(error.message, /XDG_STATE_HOME at a writable directory/)
      assert.match(error.message, /accepted baseline lives in the real state home/)
      assert.match(error.message, /\$XDG_STATE_HOME\/hyprscope\/baseline\.json/)
      return true
    },
  )
})

test('an EROFS failure inside a JSON envelope still gets the state-home hint', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({
    error: {
      code: 'COMMAND_FAILED',
      message: "EROFS: read-only file system, open '/home/user/.local/state/hyprlease/state.json'",
      details: { errno: 'EROFS' },
    },
  })
  await assert.rejects(
    invoke(harness, 'hyprscope_baseline', { action: 'probe' }),
    (error) => {
      assert.match(error.message, /^hyprscope COMMAND_FAILED: EROFS/)
      assert.match(error.message, /XDG_STATE_HOME at a writable directory/)
      assert.match(error.message, /real state home/)
      return true
    },
  )
})

test('a hung CLI call times out with an actionable timeout error', async (t) => {
  const harness = makeHarness(t, { config: { timeoutMs: 200 } })
  harness.setMode({ sleepMs: 5000 })
  const output = join(harness.projectDir, 'slow.png')
  await assert.rejects(
    invoke(harness, 'hyprscope_screenshot', { output }),
    (error) => {
      assert.match(error.message, /hyprscope did not finish within 200ms/)
      assert.match(error.message, /hyprscope screenshot/)
      assert.match(error.message, /raise the plugin timeout/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// hyprscope_events

test('events parses JSONL and maps match/count/timeout argv', async (t) => {
  const harness = makeHarness(t)
  const value = await invoke(harness, 'hyprscope_events', {
    match: '^openwindow:', count: 2, timeoutMs: 500,
  })
  assert.deepEqual(harness.lastArgv(), [
    'events',
    '--match', '^openwindow:',
    '--count', '2',
    '--timeout', '500',
    '--json',
  ])
  assert.equal(value.count, 2)
  assert.equal(value.timedOut, false)
  assert.equal(value.timeoutMs, 500)
  assert.deepEqual(value.events, [
    {
      event: 'openwindow',
      data: '0x55,workspace 1,class:kitty',
      raw: 'openwindow>>0x55,workspace 1,class:kitty',
    },
    { event: 'activewindow', data: 'kitty', raw: 'activewindow>>kitty' },
  ])
})

test('events with --once and a CLI TIMEOUT is a successful timed-out read', async (t) => {
  const harness = makeHarness(t)
  const jsonl = [
    JSON.stringify({ event: 'workspace', data: '2', raw: 'workspace>>2' }),
    '',
  ].join('\n')
  harness.setMode({
    stdout: jsonl,
    error: { code: 'TIMEOUT', message: 'No matching event before the timeout', details: { timeoutMs: 250 } },
  })
  const value = await invoke(harness, 'hyprscope_events', { once: true, timeoutMs: 250 })
  assert.deepEqual(harness.lastArgv(), ['events', '--once', '--timeout', '250', '--json'])
  assert.deepEqual(value.events, [{ event: 'workspace', data: '2', raw: 'workspace>>2' }])
  assert.equal(value.count, 1)
  assert.equal(value.timedOut, true)
  assert.equal(value.timeoutMs, 250)
})

test('events count takes precedence over once in argv', async (t) => {
  const harness = makeHarness(t)
  await invoke(harness, 'hyprscope_events', { count: 3, once: true })
  const argv = harness.lastArgv()
  assert.ok(argv.includes('--count'))
  assert.ok(!argv.includes('--once'))
  assert.deepEqual(argv, ['events', '--count', '3', '--timeout', '5000', '--json'])
})

test('events without once/count reports timedOut and skips blank or non-JSON lines', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({
    stdout: [
      '',
      JSON.stringify({ event: 'openwindow', data: '0x55,workspace 1', raw: 'openwindow>>0x55,workspace 1' }),
      'not json at all',
      JSON.stringify({ event: 'workspace', data: '2' }),
      '',
    ].join('\n'),
  })
  const value = await invoke(harness, 'hyprscope_events', { timeoutMs: 120 })
  assert.deepEqual(harness.lastArgv(), ['events', '--timeout', '120', '--json'])
  assert.equal(value.count, 2)
  assert.equal(value.timedOut, true)
  assert.deepEqual(value.events, [
    { event: 'openwindow', data: '0x55,workspace 1', raw: 'openwindow>>0x55,workspace 1' },
    { event: 'workspace', data: '2', raw: JSON.stringify({ event: 'workspace', data: '2' }) },
  ])
})

test('events failures other than a once/count TIMEOUT still throw', async (t) => {
  const harness = makeHarness(t)
  harness.setMode({ error: { code: 'NO_SESSION', message: 'No Hyprland session found' } })
  await assert.rejects(
    invoke(harness, 'hyprscope_events', { once: true }),
    /hyprscope NO_SESSION: No Hyprland session found/,
  )
})

// ---------------------------------------------------------------------------
// hyprscope_screenshot

test('screenshot attaches the PNG when the route declares image input', async (t) => {
  const attachments = makeAttachments()
  const llm = makeLlm(['text', 'image'])
  const agent = {
    session: { requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-vision-model' } }) },
  }
  const harness = makeHarness(t, { services: { attachments, llm }, agent })
  const output = join(harness.projectDir, 'shot.png')
  const exec = execContext(agent)
  const value = await invoke(harness, 'hyprscope_screenshot', { output }, exec)

  assert.deepEqual(harness.lastArgv(), ['screenshot', '--output', output, '--json'])
  assert.ok(existsSync(output))
  assert.equal(value.path, output)
  assert.equal(value.width, 1)
  assert.equal(value.height, 1)
  assert.equal(value.bytes, PNG_BYTES.length)
  assert.match(value.sha256, /^[0-9a-f]{64}$/)
  assert.equal(value.source.scope, 'layout')
  assert.deepEqual(value.image, IMAGE_REF)
  assert.equal(Object.hasOwn(value, 'imageError'), false)

  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'fake-provider')
  assert.equal(llm.calls[0].model, 'fake-vision-model')
  assert.equal(llm.calls[0].signal, exec.signal)
  assert.equal(attachments.calls.length, 1)
  assert.equal(attachments.calls[0].mediaType, 'image/png')
  assert.equal(attachments.calls[0].name, 'shot.png')
  assert.ok(attachments.calls[0].data instanceof Uint8Array)
  assert.ok(Buffer.from(attachments.calls[0].data).equals(readFileSync(output)))

  const blocks = renderBlocks(harness, 'hyprscope_screenshot', { output }, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /^Screenshot /)
  assert.match(blocks[0].text, /1x1, 70 bytes, sha256 [0-9a-f]{16}/)
  assert.match(blocks[0].text, /scope=layout$/)
  assert.deepEqual(blocks[1], { type: 'image', attachment: IMAGE_REF })
})

test('screenshot on a text-only route reports imageError and renders one text block', async (t) => {
  const attachments = makeAttachments()
  const llm = makeLlm(['text'])
  const harness = makeHarness(t, {
    services: { attachments, llm },
    agent: { options: { provider: 'fake-provider', model: 'fake-text-model' } },
  })
  const output = join(harness.projectDir, 'text-only.png')
  const value = await invoke(harness, 'hyprscope_screenshot', { output })

  assert.equal(Object.hasOwn(value, 'image'), false)
  assert.match(value.imageError, /model "fake-text-model" does not declare image input/)
  assert.equal(attachments.calls.length, 0)
  assert.ok(existsSync(output))
  // Metadata stays intact even without an image block.
  assert.equal(value.path, output)
  assert.equal(value.bytes, PNG_BYTES.length)
  assert.equal(value.source.scope, 'layout')

  const blocks = renderBlocks(harness, 'hyprscope_screenshot', { output }, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /image not attached: model "fake-text-model" does not declare image input/)
})

test('screenshot stays text-only without an attachment store', async (t) => {
  const harness = makeHarness(t)
  const output = join(harness.projectDir, 'no-store.png')
  const value = await invoke(harness, 'hyprscope_screenshot', { output })
  assert.equal(Object.hasOwn(value, 'image'), false)
  assert.equal(value.imageError, 'no attachment store')
  const blocks = renderBlocks(harness, 'hyprscope_screenshot', { output }, value)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /image not attached: no attachment store/)
})

test('screenshot stays text-only when attachments.saveImage throws', async (t) => {
  const attachments = makeAttachments({ error: new Error('attachment store offline') })
  const llm = makeLlm(['text', 'image'])
  const harness = makeHarness(t, {
    services: { attachments, llm },
    agent: { options: { provider: 'fake-provider', model: 'fake-vision-model' } },
  })
  const output = join(harness.projectDir, 'save-fails.png')
  const value = await invoke(harness, 'hyprscope_screenshot', { output })
  assert.equal(Object.hasOwn(value, 'image'), false)
  assert.equal(value.imageError, 'attachment store offline')
  assert.equal(value.path, output)
  const blocks = renderBlocks(harness, 'hyprscope_screenshot', { output }, value)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /image not attached: attachment store offline/)
})

test('screenshot passes --allow-locked only when the caller sets it', async (t) => {
  const harness = makeHarness(t)
  const output = join(harness.projectDir, 'locked-flag.png')

  await invoke(harness, 'hyprscope_screenshot', { output })
  assert.ok(!harness.lastArgv().includes('--allow-locked'))

  await invoke(harness, 'hyprscope_screenshot', { output, allowLocked: false })
  assert.ok(!harness.lastArgv().includes('--allow-locked'))

  await invoke(harness, 'hyprscope_screenshot', { output, allowLocked: true })
  assert.deepEqual(harness.lastArgv(), ['screenshot', '--output', output, '--allow-locked', '--json'])
})

test('screenshot maps monitor and region scopes plus instance flags', async (t) => {
  const harness = makeHarness(t)
  const monitorOutput = join(harness.projectDir, 'monitor.png')
  const monitorValue = await invoke(harness, 'hyprscope_screenshot', {
    scope: 'monitor',
    monitor: 'HDMI-A-1',
    output: monitorOutput,
    desktop: 'agent',
    signature: 'sig-1',
    runtimeDir: '/run/user/1000/hypr/sig-1',
  })
  assert.deepEqual(harness.lastArgv(), [
    'screenshot',
    '--output', monitorOutput,
    '--monitor', 'HDMI-A-1',
    '--desktop', 'agent',
    '--signature', 'sig-1',
    '--runtime-dir', '/run/user/1000/hypr/sig-1',
    '--json',
  ])
  assert.equal(monitorValue.source.scope, 'monitor')
  assert.equal(monitorValue.source.monitor, 'HDMI-A-1')

  const regionOutput = join(harness.projectDir, 'region.png')
  const region = { x: 10, y: 20, width: 300, height: 200 }
  const regionValue = await invoke(harness, 'hyprscope_screenshot', { scope: 'region', region, output: regionOutput })
  assert.deepEqual(harness.lastArgv(), [
    'screenshot',
    '--output', regionOutput,
    '--region', '10,20,300,200',
    '--json',
  ])
  assert.equal(regionValue.source.scope, 'region')
  assert.deepEqual(regionValue.source.region, region)
})

test('screenshot maps one window selector to its flag plus instance flags', async (t) => {
  const harness = makeHarness(t)
  const definition = harness.definitions.get('hyprscope_screenshot')
  const windowSchema = definition.parameters.properties.window
  assert.equal(windowSchema.type, 'object')
  assert.equal(windowSchema.additionalProperties, false)
  assert.deepEqual(Object.keys(windowSchema.properties), ['id', 'app', 'title'])
  assert.deepEqual(definition.parameters.properties.window.required, undefined)

  const idOutput = join(harness.projectDir, 'window-id.png')
  const idValue = await invoke(harness, 'hyprscope_screenshot', {
    scope: 'layout',
    window: { id: '180001c6' },
    output: idOutput,
    desktop: 'agent',
    signature: 'sig-1',
    runtimeDir: '/run/user/1000/hypr/sig-1',
  })
  assert.deepEqual(harness.lastArgv(), [
    'screenshot',
    '--output', idOutput,
    '--window-id', '180001c6',
    '--desktop', 'agent',
    '--signature', 'sig-1',
    '--runtime-dir', '/run/user/1000/hypr/sig-1',
    '--json',
  ])
  assert.equal(idValue.source.scope, 'window')
  assert.deepEqual(idValue.source.monitor, null)
  assert.deepEqual(idValue.source.window, { identifier: '180001c6', appId: 'kitty', title: 'shell' })

  const appOutput = join(harness.projectDir, 'window-app.png')
  const appValue = await invoke(harness, 'hyprscope_screenshot', {
    window: { app: 'zen' },
    output: appOutput,
    allowLocked: true,
  })
  assert.deepEqual(harness.lastArgv(), [
    'screenshot', '--output', appOutput, '--window-app', 'zen', '--allow-locked', '--json',
  ])
  assert.equal(appValue.source.scope, 'window')
  assert.equal(appValue.source.window.appId, 'zen')

  const titleOutput = join(harness.projectDir, 'window-title.png')
  const titleValue = await invoke(harness, 'hyprscope_screenshot', {
    window: { title: 'DSH docs' },
    output: titleOutput,
  })
  assert.deepEqual(harness.lastArgv(), [
    'screenshot', '--output', titleOutput, '--window-title', 'DSH docs', '--json',
  ])
  assert.equal(titleValue.source.window.title, 'DSH docs')
})

test('screenshot rejects a malformed or misplaced window selector without spawning', async (t) => {
  const harness = makeHarness(t)
  const cases = [
    [{ window: null }, /hyprscope_screenshot: window must be an object with exactly one of id, app, or title/],
    [{ window: 'kitty' }, /hyprscope_screenshot: window must be an object with exactly one of id, app, or title/],
    [{ window: {} }, /hyprscope_screenshot: window must provide exactly one of id, app, or title/],
    [{ window: { id: '0x55', app: 'kitty' } }, /window must provide exactly one of id, app, or title/],
    [{ window: { id: '' } }, /hyprscope_screenshot: window\.id must be a non-empty string/],
    [{ window: { title: '  ' } }, /hyprscope_screenshot: window\.title must be a non-empty string/],
    [{ window: { id: '0x55' }, monitor: 'HDMI-A-1' }, /window is only valid when scope is omitted or "layout"/],
    [
      { window: { id: '0x55' }, region: { x: 0, y: 0, width: 1, height: 1 } },
      /window is only valid when scope is omitted or "layout"/,
    ],
    [
      { window: { id: '0x55' }, scope: 'monitor', monitor: 'HDMI-A-1' },
      /window is only valid when scope is omitted or "layout"/,
    ],
    [
      { window: { id: '0x55' }, scope: 'region', region: { x: 0, y: 0, width: 1, height: 1 } },
      /window is only valid when scope is omitted or "layout"/,
    ],
  ]
  for (const [args, pattern] of cases) {
    await assert.rejects(invoke(harness, 'hyprscope_screenshot', args), pattern)
  }
  assert.equal(harness.calls().length, 0)
})

test('screenshot defaults the output below the configured screenshotDir', async (t) => {
  const harness = makeHarness(t, {
    config: (projectDir) => ({ screenshotDir: join(projectDir, 'shots') }),
  })
  const value = await invoke(harness, 'hyprscope_screenshot', {})
  const screenshotDir = join(harness.projectDir, 'shots')
  assert.ok(existsSync(screenshotDir))
  assert.equal(dirname(value.path), screenshotDir)
  assert.match(value.path, /\.png$/)
  assert.ok(existsSync(value.path))
  const argv = harness.lastArgv()
  assert.equal(argv[0], 'screenshot')
  assert.equal(argv[1], '--output')
  assert.equal(argv[2], value.path)
  assert.ok(value.imageError !== undefined) // no attachment service is mounted here
})

test('screenshot rejects a relative output and misplaced scope flags without spawning', async (t) => {
  const harness = makeHarness(t)
  await assert.rejects(
    invoke(harness, 'hyprscope_screenshot', { output: 'relative.png' }),
    /hyprscope_screenshot: output must be an absolute path/,
  )
  await assert.rejects(
    invoke(harness, 'hyprscope_screenshot', { scope: 'layout', monitor: 'HDMI-A-1' }),
    /monitor is only valid when scope is "monitor"/,
  )
  await assert.rejects(
    invoke(harness, 'hyprscope_screenshot', { scope: 'monitor', monitor: 'HDMI-A-1', region: { x: 0, y: 0, width: 1, height: 1 } }),
    /region is only valid when scope is "region"/,
  )
  assert.equal(harness.calls().length, 0)
})

// ---------------------------------------------------------------------------
// hyprscope_plan

test('plan validate maps planPath, adds --dry-run and leaves stdin untouched', async (t) => {
  const harness = makeHarness(t)
  const planPath = join(harness.projectDir, 'plan.json')
  const plan = { version: 1, steps: [{ op: 'window.focus' }] }
  writeFileSync(planPath, JSON.stringify(plan), 'utf8')

  const value = await invoke(harness, 'hyprscope_plan', { action: 'validate', planPath })
  assert.deepEqual(harness.lastArgv(), ['control', 'run', planPath, '--dry-run', '--json'])
  assert.equal(value.planFileContent, JSON.stringify(plan))
  // A file path is passed straight through: the plugin writes no stdin.
  assert.equal(value.submittedPlan, null)
  assert.equal(value.stdinEof, false)
  assert.equal(value.stdinBytes, 0)

  const text = renderText(harness, 'hyprscope_plan', { action: 'validate' }, value)
  const rendered = JSON.parse(text)
  assert.deepEqual(rendered, {
    ok: true,
    summary: { version: 1, steps: 1, kinds: { 'window.focus': 1 } },
    target: { kind: 'user', signature: 'sig-1' },
    baseline: { present: true, state: 'accepted' },
    staleness: { verdict: 'fresh', reasons: [] },
    note: 'dry run: no consent card and no desktop change',
  })
  assert.equal(Object.hasOwn(rendered, 'plan'), false)
  assert.equal(Object.hasOwn(rendered, 'canonical'), false)
  assert.equal(Object.hasOwn(rendered, 'hash'), false)
})

test('plan inline object travels on stdin and leaves no temp plan file', async (t) => {
  const harness = makeHarness(t)
  const plan = {
    version: 1,
    id: 'inline-validate',
    steps: [
      { op: 'window.focus', client: '0x55' },
      { op: 'window.move', x: 10, y: 20 },
    ],
  }
  const before = tempPlanFiles()
  const value = await invoke(harness, 'hyprscope_plan', { action: 'validate', plan })
  // The document goes to `control run -`; no path is ever synthesized.
  assert.deepEqual(harness.lastArgv(), ['control', 'run', '-', '--dry-run', '--json'])
  const expected = JSON.stringify(plan)
  assert.equal(value.stdinEof, true)
  assert.equal(value.stdinBytes, Buffer.byteLength(expected, 'utf8'))
  assert.equal(value.planFileContent, null)
  assert.deepEqual(value.submittedPlan, plan)
  // The old temp-file path must be gone: nothing appears in the temp directory.
  assert.deepEqual(tempPlanFiles(), before)
})

test('plan requires exactly one of planPath or plan', async (t) => {
  const harness = makeHarness(t)
  await assert.rejects(
    invoke(harness, 'hyprscope_plan', { action: 'validate' }),
    /pass exactly one of planPath or plan/,
  )
  await assert.rejects(
    invoke(harness, 'hyprscope_plan', {
      action: 'validate',
      planPath: join(harness.projectDir, 'plan.json'),
      plan: { version: 1, steps: [] },
    }),
    /pass exactly one of planPath or plan/,
  )
  await assert.rejects(
    invoke(harness, 'hyprscope_plan', { action: 'validate', plan: [] }),
    /hyprscope_plan: plan must be a JSON object/,
  )
  assert.equal(harness.calls().length, 0)
})

test('plan run maps --consent and --max-resumes and renders the run projection', async (t) => {
  const harness = makeHarness(t)
  const planPath = join(harness.projectDir, 'run-plan.json')
  writeFileSync(planPath, JSON.stringify({ version: 1, steps: [{ op: 'window.focus' }] }), 'utf8')

  const value = await invoke(harness, 'hyprscope_plan', {
    action: 'run', planPath, consentSeconds: 30, maxResumes: 2,
  })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'run', planPath,
    '--consent', '30',
    '--max-resumes', '2',
    '--json',
  ])
  assert.equal(value.status, 'completed')
  // A planPath still goes through as a file argument with no stdin document.
  assert.equal(value.submittedPlan, null)
  assert.equal(value.stdinEof, false)

  const text = renderText(harness, 'hyprscope_plan', { action: 'run' }, value)
  const rendered = JSON.parse(text)
  assert.deepEqual(rendered, {
    status: 'completed',
    runId: 'run-test-1',
    dir: join(harness.projectDir, 'out', 'runs', 'run-test-1'),
    durationMs: 1234,
    target: { kind: 'user', signature: 'sig-1' },
    baseline: { present: true, state: 'accepted' },
    fault: null,
    attempts: [{ attempt: 1, status: 'completed', steps: 1 }],
    screenshotCount: 1,
    note: `artifacts (plan, timeline, screenshots) live under ${join(harness.projectDir, 'out', 'runs', 'run-test-1')}`,
  })
  assert.equal(Object.hasOwn(rendered, 'steps'), false)
})

test('plan inline run sends the plan on stdin with consent/resume flags', async (t) => {
  const harness = makeHarness(t)
  const plan = { version: 1, id: 'inline-run', steps: [{ op: 'window.focus' }] }
  const value = await invoke(harness, 'hyprscope_plan', {
    action: 'run', plan, consentSeconds: 20, maxResumes: 0,
  })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'run', '-', '--consent', '20', '--max-resumes', '0', '--json',
  ])
  assert.equal(value.stdinEof, true)
  assert.deepEqual(value.submittedPlan, plan)
  assert.equal(value.planFileContent, null)
  assert.equal(value.status, 'completed')
})

test('plan run defaults consent/max-resumes', async (t) => {
  const harness = makeHarness(t)
  const planPath = join(harness.projectDir, 'default-plan.json')
  writeFileSync(planPath, JSON.stringify({ version: 1, steps: [] }), 'utf8')
  await invoke(harness, 'hyprscope_plan', { action: 'run', planPath })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'run', planPath, '--consent', '45', '--max-resumes', '1', '--json',
  ])
})

// ---------------------------------------------------------------------------
// hyprscope_baseline

test('baseline show maps --show and --diff', async (t) => {
  const harness = makeHarness(t)
  const value = await invoke(harness, 'hyprscope_baseline', { action: 'show' })
  assert.deepEqual(harness.lastArgv(), ['control', 'baseline', '--show', '--json'])
  assert.equal(value.state, 'accepted')

  await invoke(harness, 'hyprscope_baseline', { action: 'show', diff: true, desktop: 'external' })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'baseline', '--show', '--diff', '--desktop', 'external', '--json',
  ])
})

test('baseline probe maps --read-only and --consent', async (t) => {
  const harness = makeHarness(t)
  const value = await invoke(harness, 'hyprscope_baseline', {
    action: 'probe', readOnly: true, consentSeconds: 30,
  })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'baseline', '--probe', '--read-only', '--consent', '30', '--json',
  ])
  assert.equal(value.mode, 'read-only')

  await invoke(harness, 'hyprscope_baseline', { action: 'probe' })
  assert.deepEqual(harness.lastArgv(), ['control', 'baseline', '--probe', '--consent', '45', '--json'])
})

test('baseline probe carries the host confirmation card and never passes --accept', async (t) => {
  const harness = makeHarness(t)
  const definition = harness.definitions.get('hyprscope_baseline')
  const description = definition.description
  assert.match(description, /Inspect or probe/)
  assert.doesNotMatch(description, /\baccept the capability baseline\b/)
  assert.match(description, /When the measurement widens the accepted baseline/)
  assert.match(description, /same call also shows the host a confirmation card/)
  assert.match(description, /returns only after the host clicks Allow or Deny/)
  assert.match(description, /draft stays pending/)
  assert.match(description, /never answers that card/)
  assert.match(description, /never claims the baseline was accepted/)

  const value = await invoke(harness, 'hyprscope_baseline', { action: 'probe', consentSeconds: 90 })
  assert.deepEqual(harness.lastArgv(), ['control', 'baseline', '--probe', '--consent', '90', '--json'])
  assert.equal(harness.lastArgv().includes('--accept'), false)
  assert.equal(value.probeId, 'probe-test-1')
})

test('baseline rejects the removed accept action and flags that belong to another action', async (t) => {
  const harness = makeHarness(t)
  const definition = harness.definitions.get('hyprscope_baseline')
  assert.deepEqual(definition.parameters.properties.action.enum, ['show', 'probe'])
  // Acceptance is carried by the probe call itself: there is no accept action
  // and no boolean switch the agent could set silently.
  assert.equal(Object.hasOwn(definition.parameters.properties, 'accept'), false)
  assert.match(
    definition.parameters.properties.action.description,
    /may ask the host to confirm a wider baseline/,
  )
  assert.match(
    definition.parameters.properties.consentSeconds.description,
    /probe only: how long the consent and confirmation cards wait/,
  )
  assert.match(definition.description, /confirmation card/)
  assert.match(definition.description, /never answers that card/)

  await assert.rejects(
    invoke(harness, 'hyprscope_baseline', { action: 'show', readOnly: true }),
    /hyprscope_baseline: readOnly is only valid with action "probe"/,
  )
  await assert.rejects(
    invoke(harness, 'hyprscope_baseline', { action: 'probe', diff: true }),
    /hyprscope_baseline: diff is only valid with action "show"/,
  )
  await assert.rejects(
    invoke(harness, 'hyprscope_baseline', { action: 'accept' }),
    /hyprscope_baseline: action must be one of show, probe/,
  )
  assert.equal(harness.calls().length, 0)
})

// ---------------------------------------------------------------------------
// hyprscope_desktop

test('desktop start maps size and consent source', async (t) => {
  const harness = makeHarness(t)
  const value = await invoke(harness, 'hyprscope_desktop', {
    action: 'start', size: '1280x800', consentSource: 'card',
  })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'desktop', 'start',
    '--size', '1280x800',
    '--consent-source', 'card',
    '--json',
  ])
  assert.equal(value.state, 'running')

  await invoke(harness, 'hyprscope_desktop', { action: 'start' })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'desktop', 'start', '--consent-source', 'chat', '--json',
  ])
})

test('desktop attach requires runtimeDir and passes runtime-dir/signature', async (t) => {
  const harness = makeHarness(t)
  const runtimeDir = '/run/user/1000/hypr/sig-ext'
  const value = await invoke(harness, 'hyprscope_desktop', {
    action: 'attach', runtimeDir, signature: 'sig-ext', consentSource: 'card',
  })
  assert.deepEqual(harness.lastArgv(), [
    'control', 'desktop', 'attach',
    '--runtime-dir', runtimeDir,
    '--consent-source', 'card',
    '--signature', 'sig-ext',
    '--json',
  ])
  assert.equal(value.target, 'external')
  assert.equal(value.runtimeDir, runtimeDir)
  assert.equal(value.signature, 'sig-ext')

  await assert.rejects(
    invoke(harness, 'hyprscope_desktop', { action: 'attach' }),
    /hyprscope_desktop: runtimeDir must be a non-empty string/,
  )
  assert.equal(harness.calls().length, 1)
})

test('desktop status and stop pass no selector flags', async (t) => {
  const harness = makeHarness(t)
  for (const action of ['status', 'stop']) {
    const value = await invoke(harness, 'hyprscope_desktop', { action })
    const argv = harness.lastArgv()
    assert.deepEqual(argv, ['control', 'desktop', action, '--json'])
    for (const flag of ['--desktop', '--signature', '--runtime-dir']) {
      assert.ok(!argv.includes(flag), `${action} must not pass ${flag}`)
    }
    assert.equal(typeof value.state, 'string')
  }
})

test('desktop start validates the requested size before spawning', async (t) => {
  const harness = makeHarness(t)
  await assert.rejects(
    invoke(harness, 'hyprscope_desktop', { action: 'start', size: 'big' }),
    /hyprscope_desktop: size must look like 1280x800/,
  )
  assert.equal(harness.calls().length, 0)
})

// ---------------------------------------------------------------------------
// Render contract: every tool must return ContentBlock[], never a bare string
// (a live integration run of hyprscope_events once returned a string and failed
// the tool pipeline with "content.some is not a function").

test('every tool render returns non-empty ContentBlock arrays (all six tools)', (t) => {
  const harness = makeHarness(t)
  /** Representative canonical values for one render call per tool. */
  const cases = [
    { name: 'hyprscope_observe', args: { kind: 'active' }, value: ACTIVE_VALUE },
    { name: 'hyprscope_observe', args: { kind: 'clients' }, value: CLIENTS_VALUE },
    { name: 'hyprscope_screenshot', args: {}, value: { ...CAPTURE_VALUE, imageError: 'no attachment store' } },
    { name: 'hyprscope_screenshot', args: {}, value: { ...CAPTURE_VALUE, image: IMAGE_REF } },
    { name: 'hyprscope_events', args: {}, value: EMPTY_EVENTS_VALUE },
    { name: 'hyprscope_events', args: { match: '^openwindow:' }, value: EVENTS_VALUE },
    {
      name: 'hyprscope_plan',
      args: { action: 'validate' },
      value: {
        ok: true,
        summary: { version: 1, steps: 1 },
        plan: { version: 1, steps: [] },
        canonical: { version: 1 },
        target: { kind: 'user' },
        baseline: { present: true, state: 'accepted' },
        staleness: { verdict: 'fresh', reasons: [] },
      },
    },
    {
      name: 'hyprscope_plan',
      args: { action: 'run' },
      value: {
        status: 'completed',
        runId: 'run-1',
        dir: '/tmp/run-1',
        durationMs: 12,
        target: {},
        baseline: {},
        fault: null,
        attempts: [{ attempt: 1, status: 'completed', steps: 1 }],
        steps: [{ kind: 'window.focus' }],
        screenshots: [],
      },
    },
    { name: 'hyprscope_baseline', args: { action: 'show' }, value: { state: 'accepted', present: true } },
    {
      name: 'hyprscope_baseline',
      args: { action: 'probe' },
      value: { probeId: 'probe-1', mode: 'read-only', supported: [], unsupported: [], unknown: [] },
    },
    { name: 'hyprscope_desktop', args: { action: 'status' }, value: { state: 'none', pid: null } },
  ]
  // Every registered tool must appear at least once; a new tool that never
  // renders is exactly the regression this contract exists to catch.
  assert.deepEqual(
    [...new Set(cases.map((item) => item.name))].sort(),
    [...TOOL_NAMES].sort(),
    'the render contract must cover all six tools',
  )
  for (const item of cases) {
    const blocks = renderBlocks(harness, item.name, item.args, item.value)
    assert.ok(Array.isArray(blocks), `${item.name} render must return an array, got ${typeof blocks}`)
    // The tool pipeline calls Array.prototype.some on the render result; a bare
    // string produced "content.some is not a function" in a live run.
    assert.equal(typeof blocks.some, 'function', `${item.name} render result must support .some`)
    assert.ok(blocks.length > 0, `${item.name} render must return at least one block`)
    assert.ok(blocks.some((block) => typeof block.type === 'string'), `${item.name} render must yield a typed block`)
    for (const block of blocks) {
      assert.equal(typeof block, 'object', `${item.name} render blocks must be objects`)
      assert.notEqual(block, null)
      assert.equal(typeof block.type, 'string', `${item.name} render blocks need a string type`)
      if (block.type === 'text') assert.equal(typeof block.text, 'string')
    }
  }
})

test('events render is one text block containing the event JSON', (t) => {
  const harness = makeHarness(t)
  const definition = harness.definitions.get('hyprscope_events')

  const emptyBlocks = definition.output.render({}, EMPTY_EVENTS_VALUE)
  assert.ok(Array.isArray(emptyBlocks))
  assert.equal(emptyBlocks.length, 1)
  assert.equal(emptyBlocks[0].type, 'text')
  assert.equal(typeof emptyBlocks[0].text, 'string')
  assert.match(emptyBlocks[0].text, /"events":\[\]/)
  assert.match(emptyBlocks[0].text, /"timedOut":true/)
  assert.match(emptyBlocks[0].text, /"timeoutMs":600/)

  const blocks = definition.output.render({ match: '^openwindow:' }, EVENTS_VALUE)
  assert.ok(Array.isArray(blocks))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /"event":"openwindow"/)
  assert.match(blocks[0].text, /openwindow>>0x55,workspace 1/)
  assert.match(blocks[0].text, /"event":"activewindow"/)
  assert.match(blocks[0].text, /"count":2/)
})

test('events render compacts a long event list with omitted', (t) => {
  const harness = makeHarness(t, { config: { maxRenderChars: 400 } })
  const events = Array.from({ length: 20 }, (_, index) => ({
    event: 'workspace',
    data: `workspace-${index}`,
    raw: `workspace>>workspace-${index}`,
  }))
  const value = { events, count: events.length, timedOut: false, timeoutMs: 600 }
  const text = renderText(harness, 'hyprscope_events', {}, value)
  assert.ok(text.length <= 400)
  const compacted = JSON.parse(text)
  assert.equal(compacted.count, events.length)
  assert.ok(compacted.events.length < events.length)
  assert.equal(compacted.omitted, events.length - compacted.events.length)
  assert.deepEqual(compacted.events, events.slice(0, compacted.events.length))
})

test('screenshot render is [text] without an image and [text, image] with one', (t) => {
  const harness = makeHarness(t)
  const definition = harness.definitions.get('hyprscope_screenshot')

  const textOnly = definition.output.render({}, { ...CAPTURE_VALUE, imageError: 'no attachment store' })
  assert.ok(Array.isArray(textOnly))
  assert.equal(textOnly.length, 1)
  assert.equal(textOnly[0].type, 'text')
  assert.match(textOnly[0].text, /image not attached: no attachment store/)

  const withImage = definition.output.render({}, { ...CAPTURE_VALUE, image: IMAGE_REF })
  assert.ok(Array.isArray(withImage))
  assert.equal(withImage.length, 2)
  assert.equal(withImage[0].type, 'text')
  assert.deepEqual(withImage[1], { type: 'image', attachment: IMAGE_REF })
})

test('screenshot render appends the captured window only for a window source', (t) => {
  const harness = makeHarness(t)
  const definition = harness.definitions.get('hyprscope_screenshot')
  const windowSource = {
    monitor: null,
    region: null,
    scope: 'window',
    window: { identifier: '180001c6', appId: 'zen', title: 'DSH docs' },
  }

  const windowText = renderText(harness, 'hyprscope_screenshot', {}, {
    ...CAPTURE_VALUE,
    source: windowSource,
    imageError: 'no attachment store',
  })
  assert.match(windowText, /scope=window window=zen "DSH docs" \(image not attached: no attachment store\)$/)

  const layoutText = renderText(harness, 'hyprscope_screenshot', {}, CAPTURE_VALUE)
  assert.match(layoutText, /scope=layout$/)
  assert.equal(definition.output.render({}, { ...CAPTURE_VALUE, source: windowSource }).length, 1)
})

// ---------------------------------------------------------------------------
// Global safety audit over every command the plugin generated in this run

test('every argv ends with --json and no call passes the removed --accept flag', () => {
  assert.ok(recordedCalls.length >= 20, `expected many recorded CLI calls, got ${recordedCalls.length}`)
  for (const call of recordedCalls) {
    assert.ok(Array.isArray(call.argv))
    assert.equal(call.argv.at(-1), '--json', `--json must be last: ${JSON.stringify(call.argv)}`)
    // Baseline acceptance now happens inside the probe call, so the removed
    // `--accept` flag must never reach the CLI from any tool.
    assert.equal(call.argv.includes('--accept'), false,
      `--accept must never be generated: ${JSON.stringify(call.argv)}`)
    // The fake records its own cwd; a shell detour or a retargeted projectDir
    // would show up here.
    assert.equal(typeof call.cwd, 'string')
    assert.ok(call.cwd.length > 0)
  }
})
