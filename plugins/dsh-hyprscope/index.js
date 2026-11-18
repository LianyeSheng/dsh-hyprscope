/**
 * Hyprland desktop observation and control for DeepSeek Harness.
 *
 * Host-only plugin: every tool is a thin wrapper that spawns
 * `node <projectDir>/bin/hyprscope.ts ... --json` with `execFile` (argv array,
 * never a shell), a timeout and an output cap, and parses the CLI's JSON. The
 * CLI stays the only implementation: this file adds no consent, lease,
 * capability-baseline or screenshot gate and can therefore bypass none of them.
 *
 * Read-only tools map to the bare observation commands. Control tools map to
 * `hyprscope control ...` and inherit the lease, capability-baseline and
 * locked-screenshot behaviour exactly as the CLI enforces it.
 *
 * No dependency and no import outside `node:` builtins: the bundle must resolve
 * without installing anything and runs in the Host process.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin name shown in Cordis diagnostics. */
export const name = 'dsh-hyprscope'

/** The plugin only needs the tool registry; systemPrompt is injected optionally. */
export const inject = ['tools']

/** Every output.schema uses the open-object root required by the tool registry. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

const DESKTOP_VALUES = ['user', 'agent', 'external']
const OBSERVE_KINDS = ['doctor', 'state', 'active', 'clients', 'workspaces', 'monitors', 'layers', 'cursor']
const SCREENSHOT_SCOPES = ['layout', 'monitor', 'region']
const LEASE_ACTIONS = ['request', 'status', 'done', 'panic']
const PLAN_ACTIONS = ['validate', 'run']
const BASELINE_ACTIONS = ['show', 'probe', 'accept']
const DESKTOP_ACTIONS = ['start', 'attach', 'status', 'stop']
const CONSENT_SOURCES = ['chat', 'card']

/** stdin target that makes `control run` read the plan document from stdin. */
const PLAN_STDIN_TARGET = '-'

/** Default id of the synthesized one-step plan behind hyprscope_act. */
const ACT_DEFAULT_PLAN_ID = 'act'

/** Plan ids the CLI accepts; checked here so a bad id fails before spawning. */
const PLAN_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** Longest consent-card reason hyprscope_act accepts. */
const REASON_MAX_CHARS = 200

/** Collection kinds that render as an array of items. */
const ARRAY_KINDS = new Set(['clients', 'workspaces', 'monitors', 'layers'])

/** Top-level keys kept when the doctor report is too long for the model context. */
const DOCTOR_SUMMARY_KEYS = [
  'discovery', 'compositor', 'inventory', 'target', 'capabilities', 'baseline', 'isolation', 'limitations',
]

/** Exact note added when a state snapshot is replaced by its summary. */
const STATE_SUMMARY_NOTE =
  'state summary only; call hyprscope_observe with kind clients|workspaces|monitors|layers for the lists'

/** Capability failure next step; control stays gated by an accepted baseline. */
const CAPABILITY_NEXT_STEP =
  'next step: run hyprscope_baseline with action "probe", explain the evidence, then call hyprscope_baseline action '
  + '"accept": the desktop shows a confirmation card and the host answers it. Never claim the host accepted it.'

/** System-prompt guidance added when the systemPrompt service is available. */
const PROMPT_TEXT =
  'Use the hyprscope_* tools instead of composing hyprscope shell commands. Observation and screenshot tools are '
  + 'read-only. Any desktop change needs a lease: hyprscope_act for one single-step action (one consent card and its '
  + 'own short lease per call), hyprscope_lease request (the host gets a consent card), or hyprscope_plan run; every '
  + 'one of them requires an accepted capability baseline. If a call fails with CAPABILITY, run hyprscope_baseline '
  + 'action "probe", explain the evidence, then call hyprscope_baseline action "accept" so the host answers the '
  + 'confirmation card. Never approve a consent card on the host\'s behalf, and never claim the baseline was accepted.'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CONTROL_TIMEOUT_MS = 180_000
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_RENDER_CHARS = 7_000
const MIN_RENDER_CHARS = 64

/** Register the eight hyprscope tools and the optional prompt section. */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const runtime = { ctx, settings }
  for (const definition of createTools(runtime)) ctx.tools.register(definition)
  registerPrompt(ctx)
}

/**
 * Add the short system-prompt section. The section is optional guidance: a
 * missing systemPrompt service or an already-claimed section name must never
 * fail plugin activation.
 * @param ctx Plugin context.
 */
function registerPrompt(ctx) {
  try {
    const fiber = ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        promptCtx.systemPrompt.section({ name: 'hyprscope', order: 3050, text: PROMPT_TEXT })
      } catch {
        // A duplicate section name or a disposed service is not an activation error.
      }
    })
    // A child fiber rejected because the optional service disappeared is not fatal.
    Promise.resolve(fiber).catch(() => {})
  } catch {
    // ctx.inject itself is unavailable in some test doubles; stay silent.
  }
}

// ---------------------------------------------------------------------------
// Configuration

/**
 * Resolve and validate the plugin config. Invalid values throw, because a
 * silently wrong timeout or output cap is worse than a visible activation error.
 * @param config Raw plugin config.
 * @returns Frozen, validated settings.
 */
function resolveSettings(config) {
  const raw = config === undefined || config === null ? {} : config
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('hyprscope tools: config must be an object')
  }
  const fallbackProjectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const envProjectDir = typeof process.env.HYPRSCOPE_PROJECT_DIR === 'string'
    && process.env.HYPRSCOPE_PROJECT_DIR.trim() !== '' ? process.env.HYPRSCOPE_PROJECT_DIR : undefined
  const configuredProjectDir = raw.projectDir === undefined
    ? envProjectDir
    : readNonEmptyString(raw.projectDir, 'config.projectDir', 'hyprscope tools')
  const projectDir = resolve(configuredProjectDir === undefined ? fallbackProjectDir : configuredProjectDir)
  const nodeExecutable = raw.nodeExecutable === undefined
    ? process.execPath
    : readNonEmptyString(raw.nodeExecutable, 'config.nodeExecutable', 'hyprscope tools')
  const screenshotDir = raw.screenshotDir === undefined
    ? resolve(join(tmpdir(), 'dsh-hyprscope-screenshots'))
    : resolve(readNonEmptyString(raw.screenshotDir, 'config.screenshotDir', 'hyprscope tools'))
  const settings = {
    projectDir,
    entryPath: join(projectDir, 'bin', 'hyprscope.ts'),
    nodeExecutable,
    timeoutMs: readConfigInteger(raw.timeoutMs, 'config.timeoutMs', 1, 24 * 60 * 60 * 1000, DEFAULT_TIMEOUT_MS),
    controlTimeoutMs: readConfigInteger(
      raw.controlTimeoutMs, 'config.controlTimeoutMs', 1, 24 * 60 * 60 * 1000, DEFAULT_CONTROL_TIMEOUT_MS,
    ),
    maxOutputBytes: readConfigInteger(raw.maxOutputBytes, 'config.maxOutputBytes', 1024, 1024 * 1024 * 1024,
      DEFAULT_MAX_OUTPUT_BYTES),
    screenshotDir,
    attachScreenshotImage: raw.attachScreenshotImage === undefined
      ? true
      : readConfigBoolean(raw.attachScreenshotImage, 'config.attachScreenshotImage'),
    maxRenderChars: readConfigInteger(raw.maxRenderChars, 'config.maxRenderChars', MIN_RENDER_CHARS, 1_000_000,
      DEFAULT_MAX_RENDER_CHARS),
  }
  // Recorded for the activation-time diagnosis; every call re-checks so a
  // projectDir fixed after activation starts working without a reload.
  settings.entryPresent = existsSync(settings.entryPath)
  return Object.freeze(settings)
}

/** @param value Candidate config value. @param label Config key used in the error. @returns Positive integer. */
function readConfigInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`hyprscope tools: ${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/** @param value Candidate config value. @param label Config key used in the error. @returns Boolean. */
function readConfigBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`hyprscope tools: ${label} must be a boolean`)
  return value
}

// ---------------------------------------------------------------------------
// Tool definitions

/**
 * Build the eight tool definitions.
 * @param runtime Plugin context and validated settings.
 * @returns Raw ToolDefinition objects for ctx.tools.register.
 */
function createTools(runtime) {
  return [
    createObserveTool(runtime),
    createScreenshotTool(runtime),
    createEventsTool(runtime),
    createLeaseTool(runtime),
    createPlanTool(runtime),
    createActTool(runtime),
    createBaselineTool(runtime),
    createDesktopTool(runtime),
  ]
}

/** Shared optional instance-selector properties. */
function instanceProperties() {
  return {
    desktop: {
      type: 'string',
      enum: [...DESKTOP_VALUES],
      description: 'Desktop instance to address; omitted means the user\'s desktop.',
    },
    signature: {
      type: 'string',
      description: 'Hyprland instance signature; pins the command to that instance.',
    },
    runtimeDir: {
      type: 'string',
      description: 'Runtime directory override used for instance discovery.',
    },
  }
}

/** One tool parameter map with a false additionalProperties root. */
function parameters(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * Read-only observation tool (`hyprscope <kind> --json`).
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createObserveTool(runtime) {
  const { settings } = runtime
  return {
    name: 'hyprscope_observe',
    description:
      'Read-only Hyprland observation of the host\'s session: discover the compositor and capabilities (doctor), take '
      + 'one full snapshot (state), read the focused window and workspace (active), or read one collection (clients, '
      + 'workspaces, monitors, layers, cursor). Nothing here changes the desktop and no lease or baseline is involved. '
      + 'Long results are compacted; read the specific collection instead of re-reading state. Use the control tools '
      + 'only when a change is actually needed.',
    parameters: parameters({
      kind: {
        type: 'string',
        enum: [...OBSERVE_KINDS],
        description: 'What to read.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Per-operation CLI timeout in ms (1..600000); the tool waits this plus 5s. '
          + 'Defaults to the plugin observation timeout (30000).',
      },
      ...instanceProperties(),
    }, ['kind']),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{
        type: 'text',
        text: renderObserve(args, value, settings.maxRenderChars),
      }],
    },
    // Reading state does not mutate anything.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = readObject(args, 'hyprscope_observe')
      const kind = readEnum(input.kind, OBSERVE_KINDS, 'kind', 'hyprscope_observe')
      const timeoutMs = readOptionalInteger(input.timeoutMs, 'timeoutMs', 1, 600_000, 'hyprscope_observe')
        ?? settings.timeoutMs
      const argv = [kind, '--timeout', String(timeoutMs)]
      appendInstanceFlags(argv, input, 'hyprscope_observe')
      const result = await runCli(runtime, argv, { timeoutMs: timeoutMs + 5_000, signal: exec.signal })
      assertSuccess(result, argv)
      return parseJsonStdout(result.stdout, argv)
    },
  }
}

/**
 * Screenshot tool (`hyprscope screenshot --output ... --json`).
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createScreenshotTool(runtime) {
  const { settings } = runtime
  const tool = 'hyprscope_screenshot'
  return {
    name: tool,
    description:
      'Capture a PNG from the host\'s Hyprland session: the whole layout (scope layout), one monitor (scope monitor '
      + 'plus monitor) or a region in global layout coordinates (scope region plus region). Read-only: no lease is '
      + 'involved. Screenshots are refused while the session reports locked; allowLocked lets a locked capture through, '
      + 'so pass it only when the host asked for one. The PNG path is always returned; the image itself is attached when '
      + 'the attachment store is available and the calling model route declares image input.',
    parameters: parameters({
      scope: {
        type: 'string',
        enum: [...SCREENSHOT_SCOPES],
        description: 'What to capture; defaults to layout.',
      },
      monitor: {
        type: 'string',
        description: 'Output name such as HDMI-A-1; required when scope is monitor.',
      },
      region: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer', description: 'Left edge in global layout coordinates.' },
          y: { type: 'integer', description: 'Top edge in global layout coordinates.' },
          width: { type: 'integer', description: 'Width in logical pixels; must be positive.' },
          height: { type: 'integer', description: 'Height in logical pixels; must be positive.' },
        },
        required: ['x', 'y', 'width', 'height'],
        description: 'Region to capture; required when scope is region.',
      },
      output: {
        type: 'string',
        description: 'Absolute PNG destination path; defaults to a file under the plugin screenshot directory.',
      },
      allowLocked: {
        type: 'boolean',
        description: 'Capture even though the session reports locked. Leave unset unless the host asked for a locked '
          + 'capture; it never defaults to true.',
      },
      ...instanceProperties(),
    }, []),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderScreenshot(value, settings.maxRenderChars),
    },
    // Capture reads the compositor and writes one PNG; it mutates no desktop state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = readObject(args, tool)
      const scope = input.scope === undefined ? 'layout' : readEnum(input.scope, SCREENSHOT_SCOPES, 'scope', tool)
      const allowLocked = input.allowLocked === undefined ? false : readBoolean(input.allowLocked, 'allowLocked', tool)
      if (scope !== 'monitor' && input.monitor !== undefined) {
        throw new Error(`${tool}: monitor is only valid when scope is "monitor"`)
      }
      if (scope !== 'region' && input.region !== undefined) {
        throw new Error(`${tool}: region is only valid when scope is "region"`)
      }
      const output = input.output === undefined
        ? await defaultScreenshotPath(settings)
        : readAbsolutePath(input.output, 'output', tool)
      const argv = ['screenshot', '--output', output]
      if (scope === 'monitor') {
        argv.push('--monitor', readNonEmptyString(input.monitor, 'monitor', tool))
      } else if (scope === 'region') {
        const region = readRegion(input.region, tool)
        argv.push('--region', `${region.x},${region.y},${region.width},${region.height}`)
      }
      // Only a caller-chosen allowLocked reaches the CLI; the default stays refused.
      if (allowLocked) argv.push('--allow-locked')
      appendInstanceFlags(argv, input, tool)
      const result = await runCli(runtime, argv, { timeoutMs: settings.timeoutMs, signal: exec.signal })
      assertSuccess(result, argv)
      const capture = parseJsonStdout(result.stdout, argv)
      const attachment = await attachScreenshot(runtime, capture, exec)
      const value = { ...capture }
      if (attachment.image !== undefined) value.image = attachment.image
      else if (attachment.imageError !== undefined) value.imageError = attachment.imageError
      return value
    },
  }
}

/**
 * One bounded compositor-event subscription (`hyprscope events ... --json`).
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createEventsTool(runtime) {
  const { settings } = runtime
  const tool = 'hyprscope_events'
  return {
    name: tool,
    description:
      'Subscribe briefly to the Hyprland compositor event stream and return parsed events. Read-only. match filters '
      + 'on "event:data" (for example "^openwindow:" or "workspace|activewindow"); once stops at the first match; count '
      + 'stops after N matches; timeoutMs bounds the wait. With once or count, reaching the timeout is not an error: the '
      + 'result has timedOut:true and the events collected so far. Without them the call waits out timeoutMs and returns '
      + 'what it saw.',
    parameters: parameters({
      match: {
        type: 'string',
        description: 'Regular expression matched against "event:data"; omit to receive every event.',
      },
      count: {
        type: 'integer',
        description: 'Stop after this many matching events (1..50). Takes precedence over once.',
      },
      once: {
        type: 'boolean',
        description: 'Stop at the first matching event.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'How long to wait for events in ms (100..60000); defaults to 5000.',
      },
      ...instanceProperties(),
    }, []),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: renderEvents(value, settings.maxRenderChars),
      }],
    },
    // Listening to the event socket does not mutate the desktop.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = readObject(args, tool)
      const match = input.match === undefined ? undefined : readNonEmptyString(input.match, 'match', tool)
      const count = readOptionalInteger(input.count, 'count', 1, 50, tool)
      const once = input.once === undefined ? false : readBoolean(input.once, 'once', tool)
      const timeoutMs = readOptionalInteger(input.timeoutMs, 'timeoutMs', 100, 60_000, tool) ?? 5_000
      const argv = ['events']
      if (match !== undefined) argv.push('--match', match)
      if (count !== undefined) argv.push('--count', String(count))
      else if (once) argv.push('--once')
      argv.push('--timeout', String(timeoutMs))
      appendInstanceFlags(argv, input, tool)
      const result = await runCli(runtime, argv, { timeoutMs: timeoutMs + 10_000, signal: exec.signal })
      const events = parseJsonLines(result.stdout)
      const terminates = count !== undefined || once
      if (result.code === 0) {
        // A bare stream that ends by its own timeout is a normal bounded read.
        return { events, count: events.length, timedOut: !terminates, timeoutMs }
      }
      if (result.code !== 2) {
        const failure = parseFailure(result.stderr)
        // With --once/--count the CLI reports an expired wait as TIMEOUT on exit 1.
        if (failure !== null && failure.code === 'TIMEOUT' && terminates) {
          return { events, count: events.length, timedOut: true, timeoutMs }
        }
      }
      throw failureError(result, argv)
    },
  }
}

/**
 * Control-lease tool (`hyprscope control request|status|done|panic --json`).
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createLeaseTool(runtime) {
  const { settings } = runtime
  const tool = 'hyprscope_lease'
  return {
    name: tool,
    description:
      'Manage the hyprscope control lease. request asks the host for control: on the user desktop it shows a consent '
      + 'card and waits for Allow/Deny, while inside an agent or external desktop the lease is granted programmatically '
      + 'under the consent recorded at desktop start/attach. status is read-only and safe to poll. done releases control '
      + 'from the agent side; panic releases it immediately. Control needs an accepted, current capability baseline: if '
      + 'a call fails with CAPABILITY, run hyprscope_baseline with action "probe", explain the evidence, then call '
      + 'hyprscope_baseline action "accept" so the host answers the confirmation card. Never approve the consent card '
      + 'on the host\'s behalf.',
    parameters: parameters({
      action: {
        type: 'string',
        enum: [...LEASE_ACTIONS],
        description: 'request asks for control, status reads the lease, done and panic end it.',
      },
      reason: {
        type: 'string',
        description: 'Why the agent needs control; shown on the consent card. Required for request.',
      },
      ttlSeconds: {
        type: 'integer',
        description: 'Longest control window after approval in seconds (5..600, default 120). request only.',
      },
      consentSeconds: {
        type: 'integer',
        description: 'How long the consent card waits in seconds (5..120, default 45). request only.',
      },
      ...instanceProperties(),
    }, ['action']),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: clipText(safeStringify(value), settings.maxRenderChars) }],
    },
    async execute(args, exec) {
      const input = readObject(args, tool)
      const action = readEnum(input.action, LEASE_ACTIONS, 'action', tool)
      const argv = ['control', action]
      let timeoutMs = settings.controlTimeoutMs
      if (action === 'request') {
        if (input.reason === undefined) throw new Error(`${tool}: reason is required when action is "request"`)
        const reason = readNonEmptyString(input.reason, 'reason', tool)
        const ttlSeconds = readOptionalInteger(input.ttlSeconds, 'ttlSeconds', 5, 600, tool) ?? 120
        const consentSeconds = readOptionalInteger(input.consentSeconds, 'consentSeconds', 5, 120, tool) ?? 45
        argv.push('--reason', reason, '--ttl', String(ttlSeconds), '--consent', String(consentSeconds))
        // The card may wait for the whole consent window before the CLI returns.
        timeoutMs = (consentSeconds + 30) * 1_000
      }
      appendInstanceFlags(argv, input, tool)
      const result = await runCli(runtime, argv, { timeoutMs, signal: exec.signal })
      assertSuccess(result, argv)
      return parseJsonStdout(result.stdout, argv)
    },
  }
}

/**
 * Plan validate/run tool (`hyprscope control run <plan.json|-> [--dry-run] --json`).
 * An inline plan is sent on stdin; a planPath is passed through untouched.
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createPlanTool(runtime) {
  const { settings } = runtime
  const tool = 'hyprscope_plan'
  return {
    name: tool,
    description:
      'Validate or run a hyprscope plan. Plans are the only way to change the desktop; every step carries its premises '
      + 'and expectations, and the executor re-checks the lease before each mutation. validate is a dry run: it checks '
      + 'the target and the accepted baseline, returns a summary, and starts no consent card and no change. run shows '
      + 'the host\'s consent card on the user desktop (or uses the agent/external desktop\'s programmatic lease) and '
      + 'returns a run report with the attempts and the fault record. A fault hands the facts back for replanning; never '
      + 'invent plan kinds or ops the executor does not know, and never accept the card on the host\'s behalf.',
    parameters: parameters({
      action: {
        type: 'string',
        enum: [...PLAN_ACTIONS],
        description: 'validate is a dry run; run executes after consent.',
      },
      planPath: {
        type: 'string',
        description: 'Path to a plan JSON file. Pass exactly one of planPath or plan.',
      },
      plan: {
        type: 'object',
        additionalProperties: true,
        description: 'Inline plan object. Pass exactly one of planPath or plan.',
      },
      maxResumes: {
        type: 'integer',
        description: 'Recovery attempts one run may use (0..3, default 1). run only.',
      },
      consentSeconds: {
        type: 'integer',
        description: 'How long the consent card waits in seconds (5..120, default 45). run only.',
      },
      ...instanceProperties(),
    }, ['action']),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{
        type: 'text',
        text: renderPlan(args, value, settings.maxRenderChars),
      }],
    },
    async execute(args, exec) {
      const input = readObject(args, tool)
      const action = readEnum(input.action, PLAN_ACTIONS, 'action', tool)
      const hasPath = input.planPath !== undefined
      const hasPlan = input.plan !== undefined
      if (hasPath === hasPlan) throw new Error('pass exactly one of planPath or plan')
      let planTarget = PLAN_STDIN_TARGET
      let stdin
      if (hasPath) {
        planTarget = readNonEmptyString(input.planPath, 'planPath', tool)
      } else {
        const plan = input.plan
        if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
          throw new Error(`${tool}: plan must be a JSON object`)
        }
        stdin = JSON.stringify(plan)
      }
      const maxResumes = readOptionalInteger(input.maxResumes, 'maxResumes', 0, 3, tool) ?? 1
      const consentSeconds = readOptionalInteger(input.consentSeconds, 'consentSeconds', 5, 120, tool) ?? 45
      const argv = ['control', 'run', planTarget]
      if (action === 'validate') argv.push('--dry-run')
      else argv.push('--consent', String(consentSeconds), '--max-resumes', String(maxResumes))
      appendInstanceFlags(argv, input, tool)
      const result = await runCli(runtime, argv, {
        timeoutMs: settings.controlTimeoutMs + (consentSeconds + 20) * 1_000,
        signal: exec.signal,
        stdin,
      })
      assertSuccess(result, argv)
      return parseJsonStdout(result.stdout, argv)
    },
  }
}

/**
 * Single-action tool: one plan step submitted as a one-step plan on stdin.
 * It is only a wrapper over the plan path (`control run -`), never a separate
 * execution path, so it inherits the same capability gate, validation,
 * executor, lease and rendering as hyprscope_plan run.
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createActTool(runtime) {
  const { settings } = runtime
  const tool = 'hyprscope_act'
  return {
    name: tool,
    description:
      'Take one atomic desktop action by submitting it as a one-step plan. One atomic action is one one-step plan: '
      + 'each call shows its own consent card (on the user desktop) and acquires its own short lease, and the same '
      + 'capability baseline gate, plan validation and executor apply as hyprscope_plan run. Steps use the same fields '
      + 'as a step inside hyprscope_plan (op plus that op\'s fields, including optional requires/expect); the CLI '
      + 'validates the step, including which ops exist. The result is the same run report as hyprscope_plan run, with '
      + 'the attempts, fault record and artifacts note. A fault hands the facts back for replanning; never invent ops '
      + 'the executor does not know, and never accept the card on the host\'s behalf.',
    parameters: parameters({
      step: {
        type: 'object',
        required: ['op'],
        additionalProperties: true,
        properties: {
          op: {
            type: 'string',
            description: 'The plan op to run; the CLI lists the ops it knows and validates the op fields.',
          },
        },
        description: 'One plan step: op plus that op\'s fields (requires/expect are optional); the CLI validates it.',
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: REASON_MAX_CHARS,
        description: 'Why the action is taken (1..200 characters); shown on the consent card.',
      },
      planId: {
        type: 'string',
        pattern: '^[A-Za-z0-9._-]+$',
        maxLength: 64,
        description: 'Plan id recorded in the run artifacts (letters, digits, dot, underscore or hyphen; max 64); '
          + 'defaults to "act".',
      },
      budgetMs: {
        type: 'integer',
        minimum: 500,
        maximum: 30_000,
        description: 'Total plan budget in ms (500..30000); omitted means the CLI default.',
      },
      maxResumes: {
        type: 'integer',
        minimum: 0,
        maximum: 3,
        description: 'Recovery attempts the run may use (0..3, default 1).',
      },
      consentSeconds: {
        type: 'integer',
        minimum: 5,
        maximum: 120,
        description: 'How long the consent card waits in seconds (5..120, default 45).',
      },
    }, ['step', 'reason']),
    output: {
      schema: OUTPUT_SCHEMA,
      // Exactly the hyprscope_plan run projection: same fields and artifacts note.
      render: (_args, value) => [{
        type: 'text',
        text: renderPlan({ action: 'run' }, value, settings.maxRenderChars),
      }],
    },
    async execute(args, exec) {
      const input = readObject(args, tool)
      const step = readPlanStep(input.step, tool)
      const reason = readReason(input.reason, tool)
      const planId = input.planId === undefined ? ACT_DEFAULT_PLAN_ID : readPlanId(input.planId, tool)
      const budgetMs = readOptionalInteger(input.budgetMs, 'budgetMs', 500, 30_000, tool)
      const maxResumes = readOptionalInteger(input.maxResumes, 'maxResumes', 0, 3, tool) ?? 1
      const consentSeconds = readOptionalInteger(input.consentSeconds, 'consentSeconds', 5, 120, tool) ?? 45
      const plan = { version: 1, id: planId, reason, steps: [step] }
      if (budgetMs !== undefined) plan.budgetMs = budgetMs
      const argv = [
        'control', 'run', PLAN_STDIN_TARGET,
        '--consent', String(consentSeconds),
        '--max-resumes', String(maxResumes),
      ]
      const result = await runCli(runtime, argv, {
        timeoutMs: settings.controlTimeoutMs + (consentSeconds + 20) * 1_000,
        signal: exec.signal,
        stdin: JSON.stringify(plan),
      })
      assertSuccess(result, argv)
      return parseJsonStdout(result.stdout, argv)
    },
  }
}

/**
 * Capability-baseline tool (`hyprscope control baseline --show|--probe|--accept --json`).
 * accept asks for a confirmation card; the click that answers it is the host's,
 * so the tool only carries the request and waits for the answer.
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createBaselineTool(runtime) {
  const { settings } = runtime
  const tool = 'hyprscope_baseline'
  return {
    name: tool,
    description:
      'Inspect, probe or accept the capability baseline that gates hyprscope control. show reports the accepted '
      + 'baseline, any pending draft and, with diff, how the draft differs. probe measures this machine and writes a '
      + 'draft; it takes a lease like any control action and may show a consent card on the user desktop (readOnly '
      + 'measures without dispatching or injecting). accept turns the pending draft into the baseline: the desktop '
      + 'shows a confirmation card with the verdict, evidence hash and capability counts, and the call returns only '
      + 'after the host clicks Allow or Deny. The tool never answers that card and never claims the baseline was '
      + 'accepted. A CAPABILITY failure from plan or lease means the baseline is missing, stale or incomplete.',
    parameters: parameters({
      action: {
        type: 'string',
        enum: [...BASELINE_ACTIONS],
        description: 'show reads the accepted baseline; probe measures this machine and writes a draft; '
          + 'accept asks the host to confirm the pending draft.',
      },
      diff: {
        type: 'boolean',
        description: 'show only: compare the pending draft with the accepted baseline.',
      },
      readOnly: {
        type: 'boolean',
        description: 'probe only: measure without dispatching or injecting.',
      },
      consentSeconds: {
        type: 'integer',
        description: 'How long the consent card waits in seconds (5..120, default 45). probe and accept only.',
      },
      ...instanceProperties(),
    }, ['action']),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{
        type: 'text',
        text: renderBaseline(args, value, settings.maxRenderChars),
      }],
    },
    async execute(args, exec) {
      const input = readObject(args, tool)
      const action = readEnum(input.action, BASELINE_ACTIONS, 'action', tool)
      const diff = input.diff === undefined ? false : readBoolean(input.diff, 'diff', tool)
      const readOnly = input.readOnly === undefined ? false : readBoolean(input.readOnly, 'readOnly', tool)
      if (action !== 'probe' && readOnly) throw new Error(`${tool}: readOnly is only valid with action "probe"`)
      if (action !== 'show' && diff) throw new Error(`${tool}: diff is only valid with action "show"`)
      const consentSeconds = readOptionalInteger(input.consentSeconds, 'consentSeconds', 5, 120, tool) ?? 45
      const argv = ['control', 'baseline']
      let timeoutMs = settings.controlTimeoutMs
      if (action === 'show') {
        argv.push('--show')
        if (diff) argv.push('--diff')
      } else if (action === 'probe') {
        argv.push('--probe')
        if (readOnly) argv.push('--read-only')
        argv.push('--consent', String(consentSeconds))
        timeoutMs += (consentSeconds + 20) * 1_000
      } else {
        // accept only ever reaches the desktop as a confirmation card: the CLI
        // command asks for the host's answer and writes nothing before it.
        argv.push('--accept')
        argv.push('--consent', String(consentSeconds))
        timeoutMs += (consentSeconds + 20) * 1_000
      }
      appendInstanceFlags(argv, input, tool)
      const result = await runCli(runtime, argv, { timeoutMs, signal: exec.signal })
      assertSuccess(result, argv)
      return parseJsonStdout(result.stdout, argv)
    },
  }
}

/**
 * Agent-desktop lifecycle tool (`hyprscope control desktop start|attach|status|stop --json`).
 * @param runtime Plugin context and settings.
 * @returns Tool definition.
 */
function createDesktopTool(runtime) {
  const { settings } = runtime
  const tool = 'hyprscope_desktop'
  return {
    name: tool,
    description:
      'Manage the agent-dedicated desktop. start launches a nested Hyprland the agent owns: one consent, then runs '
      + 'inside it take programmatic leases. attach records an instance the user names and requires runtimeDir, the '
      + 'instance\'s runtime directory. status re-checks the recorded pid, instance directory, sockets and config hash. '
      + 'stop kills only an agent desktop hyprscope started, or forgets an external record. These are lifecycle '
      + 'commands, not desktop mutations: they never move or close a user window.',
    parameters: parameters({
      action: {
        type: 'string',
        enum: [...DESKTOP_ACTIONS],
        description: 'start, attach, status or stop the agent desktop.',
      },
      size: {
        type: 'string',
        description: 'start only: requested output size such as 1280x800; a request, not a guarantee.',
      },
      runtimeDir: {
        type: 'string',
        description: 'attach only: the external instance\'s runtime directory (required for attach).',
      },
      signature: {
        type: 'string',
        description: 'attach only: signature of the external instance to record.',
      },
      consentSource: {
        type: 'string',
        enum: [...CONSENT_SOURCES],
        description: 'start/attach only: how the one-time consent is taken. chat records it in the conversation '
          + '(default); card shows the overlay consent card on the user desktop.',
      },
    }, ['action']),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: clipText(safeStringify(value), settings.maxRenderChars) }],
    },
    async execute(args, exec) {
      const input = readObject(args, tool)
      const action = readEnum(input.action, DESKTOP_ACTIONS, 'action', tool)
      const argv = ['control', 'desktop', action]
      let timeoutMs = settings.controlTimeoutMs
      if (action === 'start') {
        const consentSource = input.consentSource === undefined
          ? 'chat'
          : readEnum(input.consentSource, CONSENT_SOURCES, 'consentSource', tool)
        if (input.size !== undefined) argv.push('--size', readDesktopSize(input.size, tool))
        argv.push('--consent-source', consentSource)
        timeoutMs = 120_000
      } else if (action === 'attach') {
        const runtimeDir = readNonEmptyString(input.runtimeDir, 'runtimeDir', tool)
        const consentSource = input.consentSource === undefined
          ? 'chat'
          : readEnum(input.consentSource, CONSENT_SOURCES, 'consentSource', tool)
        argv.push('--runtime-dir', runtimeDir, '--consent-source', consentSource)
        if (input.signature !== undefined) argv.push('--signature', readNonEmptyString(input.signature, 'signature', tool))
        timeoutMs = 120_000
      }
      // status/stop take no selector: the CLI re-checks or forgets the record.
      const result = await runCli(runtime, argv, { timeoutMs, signal: exec.signal })
      assertSuccess(result, argv)
      return parseJsonStdout(result.stdout, argv)
    },
  }
}

// ---------------------------------------------------------------------------
// Argument helpers (raw ToolDefinition objects validate their own arguments)

/** @param args Raw tool arguments. @param tool Tool name used in errors. @returns The argument object. */
function readObject(args, tool) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${tool}: arguments must be an object`)
  }
  return args
}

/** @returns The enum value, or throws with the allowed values. */
function readEnum(value, allowed, field, tool) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${tool}: ${field} must be one of ${allowed.join(', ')}`)
  }
  return value
}

/** @returns A non-empty string, or throws. */
function readNonEmptyString(value, field, tool) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${tool}: ${field} must be a non-empty string`)
  }
  return value
}

/** @returns The boolean value, or throws. */
function readBoolean(value, field, tool) {
  if (typeof value !== 'boolean') throw new Error(`${tool}: ${field} must be a boolean`)
  return value
}

/** @returns The integer in range, or throws. */
function readInteger(value, field, minimum, maximum, tool) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${tool}: ${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/** @returns The integer in range, or undefined. */
function readOptionalInteger(value, field, minimum, maximum, tool) {
  return value === undefined ? undefined : readInteger(value, field, minimum, maximum, tool)
}

/** @returns An absolute path, or throws. */
function readAbsolutePath(value, field, tool) {
  const path = readNonEmptyString(value, field, tool)
  if (!isAbsolute(path)) throw new Error(`${tool}: ${field} must be an absolute path`)
  return path
}

/** @returns A validated `{x,y,width,height}` region. */
function readRegion(value, tool) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${tool}: region must be an object with x, y, width and height`)
  }
  const region = {}
  for (const field of ['x', 'y', 'width', 'height']) {
    if (!Number.isSafeInteger(value[field])) {
      throw new Error(`${tool}: region.${field} must be an integer`)
    }
    region[field] = value[field]
  }
  if (region.width <= 0 || region.height <= 0) {
    throw new Error(`${tool}: region width and height must be positive`)
  }
  return region
}

/** @returns A `WxH` size string, or throws. */
function readDesktopSize(value, tool) {
  const size = readNonEmptyString(value, 'size', tool)
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (match === null || Number.parseInt(match[1], 10) <= 0 || Number.parseInt(match[2], 10) <= 0) {
    throw new Error(`${tool}: size must look like 1280x800`)
  }
  return size
}

/** @returns The plan step object unchanged; only its structure is checked here (the CLI validates the op). */
function readPlanStep(value, tool) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${tool}: step must be a plan step object with an op`)
  }
  if (typeof value.op !== 'string' || value.op.trim() === '') {
    throw new Error(`${tool}: step.op must be a non-empty string`)
  }
  return value
}

/** @returns A 1..200 character consent-card reason, or throws. */
function readReason(value, tool) {
  const reason = readNonEmptyString(value, 'reason', tool)
  if (reason.length > REASON_MAX_CHARS) {
    throw new Error(`${tool}: reason must be at most ${REASON_MAX_CHARS} characters`)
  }
  return reason
}

/** @returns A plan id the CLI accepts, or throws. */
function readPlanId(value, tool) {
  const planId = readNonEmptyString(value, 'planId', tool)
  if (planId.length > 64 || !PLAN_ID_PATTERN.test(planId)) {
    throw new Error(`${tool}: planId must be at most 64 characters of A-Z, a-z, 0-9, dot, underscore or hyphen`)
  }
  return planId
}

/**
 * Build a fresh default screenshot path below the plugin screenshot directory.
 * @param settings Validated plugin settings.
 * @returns Absolute PNG path; the directory exists afterwards.
 */
async function defaultScreenshotPath(settings) {
  await mkdir(settings.screenshotDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(settings.screenshotDir, `${stamp}-${randomBytes(4).toString('hex')}.png`)
}

/**
 * Append the optional `--desktop/--signature/--runtime-dir` selector flags.
 * @param argv Argument array to extend.
 * @param input Parsed tool arguments.
 * @param tool Tool name used in errors.
 */
function appendInstanceFlags(argv, input, tool) {
  if (input.desktop !== undefined) argv.push('--desktop', readEnum(input.desktop, DESKTOP_VALUES, 'desktop', tool))
  if (input.signature !== undefined) {
    argv.push('--signature', readNonEmptyString(input.signature, 'signature', tool))
  }
  if (input.runtimeDir !== undefined) {
    argv.push('--runtime-dir', readNonEmptyString(input.runtimeDir, 'runtimeDir', tool))
  }
}

// ---------------------------------------------------------------------------
// CLI spawning and result handling

/**
 * Spawn `node <projectDir>/bin/hyprscope.ts <argv...> --json` and settle with
 * the exit code and captured output. Transport failures (abort, timeout, output
 * cap, spawn error) reject; every CLI exit code resolves so a caller can map
 * the CLI's own errors. When `options.stdin` is set, the one document is written
 * to the child's stdin and the pipe is ended so the CLI reads it up to EOF.
 * @param runtime Plugin context and settings.
 * @param argv CLI arguments without the final `--json`.
 * @param options Effective spawn timeout, the caller's abort signal and an optional stdin document.
 * @returns Exit code and captured stdout/stderr.
 */
function runCli(runtime, argv, options) {
  const { settings } = runtime
  return new Promise((settle, fail) => {
    if (!existsSync(settings.entryPath)) {
      fail(new Error(
        `hyprscope CLI not found at ${settings.entryPath}: point the plugin's projectDir config `
        + `(or HYPRSCOPE_PROJECT_DIR) at the hyprscope repository root.`,
      ))
      return
    }
    // Accepting a baseline is the host's click on a confirmation card. Only the
    // baseline tool may generate the one command that asks for that click; every
    // other tool must keep the audit trail free of `--accept`.
    if (argv.includes('--accept') && !(argv[0] === 'control' && argv[1] === 'baseline')) {
      fail(new Error('internal error: only hyprscope_baseline accept may ask to accept a baseline'))
      return
    }
    const command = [settings.entryPath, ...argv, '--json']
    try {
      const child = execFile(settings.nodeExecutable, command, {
        cwd: settings.projectDir,
        env: process.env,
        timeout: options.timeoutMs,
        maxBuffer: settings.maxOutputBytes,
        signal: options.signal,
        windowsHide: true,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (error !== null && options.signal !== undefined && options.signal.aborted) {
          fail(new Error(`hyprscope call cancelled: ${describeCall(argv)}`))
          return
        }
        if (error !== null && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
          fail(new Error(`hyprscope call cancelled: ${describeCall(argv)}`))
          return
        }
        if (error !== null && (error.code === 'ETIMEDOUT' || error.killed === true)) {
          fail(new Error(
            `hyprscope did not finish within ${options.timeoutMs}ms: ${describeCall(argv)}. `
            + 'The compositor or a consent prompt may be unresponsive; raise the plugin timeout or check the session.',
          ))
          return
        }
        if (error !== null && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          fail(new Error(
            `hyprscope output exceeded the plugin output cap of ${settings.maxOutputBytes} bytes: ${describeCall(argv)}`,
          ))
          return
        }
        if (error !== null && typeof error.code === 'string') {
          fail(new Error(
            `cannot start hyprscope (${error.code}): ${describeCall(argv)}. `
            + `Check nodeExecutable (${settings.nodeExecutable}) and projectDir (${settings.projectDir}).`,
          ))
          return
        }
        settle({
          code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        })
      })
      // The CLI reads exactly one JSON document up to EOF, so end the pipe
      // immediately after the single write. A child that exits early (usage
      // failure, cancellation, timeout) may surface EPIPE on the pipe; that is
      // a symptom, not the call's failure signal, so it must not become an
      // unhandled error. The exit code and stderr still drive error mapping.
      if (options.stdin !== undefined) {
        child.stdin.on('error', () => {})
        child.stdin.end(options.stdin, 'utf8')
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * Short, shell-free description of one call for error messages.
 * @param argv CLI arguments.
 * @returns Text such as `hyprscope observe state`.
 */
function describeCall(argv) {
  return clipText(`hyprscope ${argv.slice(0, 3).join(' ')}`, 200)
}

/** @returns Parsed stdout JSON, or throws a descriptive error. */
function parseJsonStdout(stdout, argv) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text === '') throw new Error(`hyprscope returned no JSON output: ${describeCall(argv)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`hyprscope returned invalid JSON (${describeCall(argv)}): ${clipText(text, 500)}`)
  }
}

/** @returns Parsed JSONL events from the event stream. */
function parseJsonLines(stdout) {
  const events = []
  for (const line of (typeof stdout === 'string' ? stdout : '').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object') continue
      events.push({
        event: typeof parsed.event === 'string' ? parsed.event : '',
        data: typeof parsed.data === 'string' ? parsed.data : '',
        raw: typeof parsed.raw === 'string' ? parsed.raw : text,
      })
    } catch {
      // A non-JSON line is not an event; ignore it rather than failing the read.
    }
  }
  return events
}

/**
 * Parse the CLI's failure envelope from stderr.
 * @param stderr Captured stderr.
 * @returns `{code, message, details}` or null when stderr is not that envelope.
 */
function parseFailure(stderr) {
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text)
    const failure = parsed !== null && typeof parsed === 'object' ? parsed.error : undefined
    if (failure === null || typeof failure !== 'object') return null
    if (typeof failure.code !== 'string' || typeof failure.message !== 'string') return null
    return { code: failure.code, message: failure.message, details: failure.details }
  } catch {
    return null
  }
}

/**
 * Map a failed CLI result to an actionable Error. Exit 2 is a usage failure;
 * exit 1 carries a JSON failure envelope on stderr (or plain text for parse
 * failures that happen before JSON output is possible).
 * @param result Spawned result with a non-zero exit code.
 * @param argv CLI arguments (for context).
 * @returns The mapped Error.
 */
function failureError(result, argv) {
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  if (result.code === 2) {
    return new Error(`hyprscope rejected the arguments: ${clipText(stderr, 2_000) || describeCall(argv)}`)
  }
  const failure = parseFailure(stderr)
  if (failure !== null) return cliFailure(failure)
  const fallback = stderr !== '' ? stderr : safeStringify(result.stdout)
  return new Error(`hyprscope failed (exit ${result.code}): ${clipText(fallback, 2_000)}`)
}

/** @param failure Parsed CLI failure envelope. @returns The mapped Error. */
function cliFailure(failure) {
  let message = `hyprscope ${failure.code}: ${failure.message}`
  if (failure.details !== undefined && failure.details !== null) {
    const details = safeStringify(failure.details)
    if (details !== '{}' && details !== 'null' && details !== '""') {
      message += ` details: ${clipText(details, 600)}`
    }
  }
  if (failure.code === 'CAPABILITY') {
    message += ` ${CAPABILITY_NEXT_STEP}`
  } else if (failure.code === 'NO_SESSION' || failure.code === 'TARGET_UNAVAILABLE') {
    message += ' next step: check that Hyprland is running and that session discovery can reach it; '
      + 'pass signature or runtimeDir to target a specific instance.'
  } else if (failure.code === 'LOCKED') {
    message += ' next step: the session reports locked and screenshots are refused; unlock the session, or pass '
      + 'allowLocked only when the host explicitly asked for a locked capture.'
  }
  return new Error(message)
}

/**
 * Throw the mapped failure unless the CLI exited 0.
 * @param result Spawned result.
 * @param argv CLI arguments (for context).
 */
function assertSuccess(result, argv) {
  if (result.code !== 0) throw failureError(result, argv)
}

// ---------------------------------------------------------------------------
// Screenshot attachment

/**
 * Attach the captured PNG through the optional attachment service, but only
 * when the calling model route declares image input. A missing service, an
 * unresolved route or a failed save must not fail the tool.
 * @param runtime Plugin context and settings.
 * @param capture Parsed CLI CaptureResult.
 * @param exec Tool execution context supplying the calling agent and signal.
 * @returns `{image}` when attached, otherwise `{imageError}`.
 */
async function attachScreenshot(runtime, capture, exec) {
  const { ctx, settings } = runtime
  if (!settings.attachScreenshotImage) {
    return { imageError: 'image attachment is disabled by the plugin config' }
  }
  let attachments
  try {
    attachments = ctx.get('attachments')
  } catch {
    attachments = undefined
  }
  if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
    return { imageError: 'no attachment store' }
  }
  // Attach only when the exact calling route declares image input. An image
  // block in a result the route cannot inspect makes the next request fail with
  // UNSUPPORTED_CONTENT in the model adapter, which would poison the session;
  // the shipped read_image tool gates on the same route capability.
  const route = await resolveImageRoute(runtime, exec)
  if (route.imageError !== undefined) return route
  try {
    const path = typeof capture.path === 'string' ? capture.path : ''
    if (path === '') throw new Error('the CLI reported no screenshot path')
    const bytes = await readFile(path)
    const image = await attachments.saveImage({
      data: new Uint8Array(bytes),
      mediaType: 'image/png',
      name: basename(path),
    })
    // The image block embeds the reference in model content and the canonical
    // value, so refuse a reference that cannot be materialized as JSON.
    if (JSON.stringify(image) === undefined) {
      throw new Error('the attachment service returned a non-JSON image reference')
    }
    return { image }
  } catch (error) {
    return { imageError: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve whether the calling model route explicitly declares image input.
 * Mirrors the shipped `read_image` gate: the session's latest routed
 * provider/model (request header config, then the agent's options) must resolve
 * through the `llm` service to a model info whose `inputModalities` contains
 * `image`. Any unresolved or failing lookup is a text-only outcome, never a
 * tool failure.
 * @param runtime Plugin context and settings.
 * @param exec Tool execution context supplying the calling agent and signal.
 * @returns `{}` when the route accepts images, otherwise `{imageError}`.
 */
async function resolveImageRoute(runtime, exec) {
  try {
    const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
    const routed = agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent?.options?.provider
    const model = routed?.model ?? agent?.options?.model
    const llm = runtime.ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined
      || typeof llm.resolveModelInfo !== 'function') {
      return { imageError: 'the calling model route could not be resolved; the PNG path is still returned' }
    }
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    if (info === undefined || info === null
      || info.inputModalities === undefined || !info.inputModalities.includes('image')) {
      return { imageError: `model "${model}" does not declare image input; the PNG path is still returned` }
    }
    return {}
  } catch (error) {
    return {
      imageError: 'the calling model route could not be resolved ('
        + `${error instanceof Error ? error.message : String(error)}); the PNG path is still returned`,
    }
  }
}

// ---------------------------------------------------------------------------
// Render helpers: every tool text stays under maxRenderChars

/**
 * Render a screenshot as a text envelope plus the optional image block.
 * @param value Canonical CaptureResult (plus image or imageError).
 * @param limit Maximum text characters.
 * @returns Content blocks.
 */
function renderScreenshot(value, limit) {
  const capture = value !== null && typeof value === 'object' ? value : {}
  const source = capture.source !== null && typeof capture.source === 'object' ? capture.source : {}
  const scope = typeof source.scope === 'string' ? source.scope : 'layout'
  const sha = typeof capture.sha256 === 'string' ? capture.sha256.slice(0, 16) : 'unknown'
  const note = typeof capture.imageError === 'string' ? ` (image not attached: ${capture.imageError})` : ''
  const text = clipText(
    `Screenshot ${String(capture.path)} (${String(capture.width)}x${String(capture.height)}, `
    + `${String(capture.bytes)} bytes, sha256 ${sha}) scope=${scope}${note}`,
    limit,
  )
  const blocks = [{ type: 'text', text }]
  if (capture.image !== undefined) blocks.push({ type: 'image', attachment: capture.image })
  return blocks
}

/**
 * Render an observation result according to its kind.
 * @param args Tool arguments (the requested kind).
 * @param value Canonical CLI JSON.
 * @param limit Maximum text characters.
 * @returns Compacted JSON text.
 */
function renderObserve(args, value, limit) {
  const kind = args !== null && typeof args === 'object' && typeof args.kind === 'string' ? args.kind : ''
  if (kind === 'doctor') return renderDoctor(value, limit)
  if (kind === 'state') return renderState(value, limit)
  if (ARRAY_KINDS.has(kind)) return renderArray(value, limit)
  return clipText(safeStringify(value), limit)
}

/**
 * Render a doctor report with the raw Wayland globals removed, then with only
 * the stable summary sections when it is still too long.
 * @param value Canonical DoctorReport.
 * @param limit Maximum text characters.
 * @returns Compact JSON text.
 */
function renderDoctor(value, limit) {
  const report = value !== null && typeof value === 'object' ? { ...value } : {}
  if (report.capabilities !== null && typeof report.capabilities === 'object') {
    const capabilities = { ...report.capabilities }
    if (Object.hasOwn(capabilities, 'wayland')) {
      const wayland = capabilities.wayland
      capabilities.wayland = wayland !== null && typeof wayland === 'object'
        ? { seatCount: wayland.seatCount, capabilities: wayland.capabilities }
        : wayland
    }
    report.capabilities = capabilities
  }
  const full = safeStringify(report)
  if (full.length <= limit) return full
  const summary = {}
  for (const key of DOCTOR_SUMMARY_KEYS) if (Object.hasOwn(report, key)) summary[key] = report[key]
  const text = safeStringify(summary)
  return text.length <= limit ? text : clipText(text, limit)
}

/**
 * Render a state snapshot, falling back to the counts summary when too long.
 * @param value Canonical DesktopState.
 * @param limit Maximum text characters.
 * @returns Compact JSON text.
 */
function renderState(value, limit) {
  const state = value !== null && typeof value === 'object' ? value : {}
  const full = safeStringify(state)
  if (full.length <= limit) return full
  const summary = {
    readOnly: state.readOnly,
    observedAt: state.observedAt,
    compositor: state.compositor,
    active: state.active,
    counts: {
      monitors: Array.isArray(state.monitors) ? state.monitors.length : 0,
      workspaces: Array.isArray(state.workspaces) ? state.workspaces.length : 0,
      clients: Array.isArray(state.clients) ? state.clients.length : 0,
      layers: Array.isArray(state.layers) ? state.layers.length : 0,
    },
    lock: state.lock,
    note: STATE_SUMMARY_NOTE,
  }
  const text = safeStringify(summary)
  return text.length <= limit ? text : clipText(text, limit)
}

/**
 * Render an array kind, keeping the longest prefix of items that fits.
 * @param value Canonical array.
 * @param limit Maximum text characters.
 * @returns Compact JSON text with total/returned/omitted.
 */
function renderArray(value, limit) {
  const items = Array.isArray(value) ? value : []
  const full = safeStringify(items)
  if (full.length <= limit) return full
  const candidate = (count) => safeStringify({
    total: items.length,
    returned: count,
    omitted: items.length - count,
    items: items.slice(0, count),
  })
  let low = 0
  let high = items.length
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (candidate(middle).length <= limit) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const text = candidate(best)
  return text.length <= limit ? text : clipText(text, limit)
}

/**
 * Render an events result, keeping the first events that fit and marking the rest.
 * @param value Canonical `{events, count, timedOut, timeoutMs}`.
 * @param limit Maximum text characters.
 * @returns Compact JSON text.
 */
function renderEvents(value, limit) {
  const eventList = value !== null && typeof value === 'object' && Array.isArray(value.events) ? value.events : []
  const full = safeStringify(value)
  if (full.length <= limit) return full
  const candidate = (count) => safeStringify({
    events: eventList.slice(0, count),
    count: eventList.length,
    timedOut: value !== null && typeof value === 'object' ? value.timedOut : false,
    timeoutMs: value !== null && typeof value === 'object' ? value.timeoutMs : null,
    omitted: eventList.length - count,
  })
  let low = 0
  let high = eventList.length
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (candidate(middle).length <= limit) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const text = candidate(best)
  return text.length <= limit ? text : clipText(text, limit)
}

/**
 * Render a plan result: the dry-run preview or the run report projection.
 * @param args Tool arguments (the requested action).
 * @param value Canonical CLI JSON.
 * @param limit Maximum text characters.
 * @returns Compact JSON text.
 */
function renderPlan(args, value, limit) {
  const action = args !== null && typeof args === 'object' ? args.action : undefined
  const result = value !== null && typeof value === 'object' ? value : {}
  if (action === 'validate') {
    const projected = {
      ok: true,
      summary: result.summary,
      target: result.target,
      baseline: result.baseline,
      staleness: result.staleness,
      note: 'dry run: no consent card and no desktop change',
    }
    const text = safeStringify(projected)
    return text.length <= limit ? text : clipText(text, limit)
  }
  const attempts = Array.isArray(result.attempts)
    ? result.attempts.map((attempt) => {
      const item = {
        attempt: attempt !== null && typeof attempt === 'object' ? attempt.attempt : null,
        status: attempt !== null && typeof attempt === 'object' ? attempt.status : null,
        steps: attempt !== null && typeof attempt === 'object' ? attempt.steps : null,
      }
      if (attempt !== null && typeof attempt === 'object' && attempt.broken !== null && attempt.broken !== undefined) {
        item.broken = attempt.broken
      }
      return item
    })
    : []
  const projected = {
    status: result.status,
    runId: result.runId,
    dir: result.dir,
    durationMs: result.durationMs,
    target: result.target,
    baseline: result.baseline,
    fault: result.fault === undefined ? null : result.fault,
    attempts,
    screenshotCount: Array.isArray(result.screenshots) ? result.screenshots.length : 0,
    note: `artifacts (plan, timeline, screenshots) live under ${String(result.dir)}`,
  }
  const text = safeStringify(projected)
  return text.length <= limit ? text : clipText(text, limit)
}

/**
 * Render a baseline report; a probe report that is too long drops the
 * per-capability detail strings before any hard truncation.
 * @param args Tool arguments (the requested action).
 * @param value Canonical CLI JSON.
 * @param limit Maximum text characters.
 * @returns Compact JSON text.
 */
function renderBaseline(args, value, limit) {
  const action = args !== null && typeof args === 'object' ? args.action : undefined
  const full = safeStringify(value)
  if (full.length <= limit || action !== 'probe' || value === null || typeof value !== 'object') {
    return full.length <= limit ? full : clipText(full, limit)
  }
  const projected = { ...value }
  for (const key of ['supported', 'unsupported', 'unknown']) {
    if (Array.isArray(value[key])) {
      projected[key] = value[key].map((line) => {
        if (line === null || typeof line !== 'object') return line
        const { detail: _detail, ...rest } = line
        return rest
      })
    }
  }
  const text = safeStringify(projected)
  return text.length <= limit ? text : clipText(text, limit)
}

/** @returns JSON text, or a safe fallback. */
function safeStringify(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 'null' : text
  } catch {
    return String(value)
  }
}

/**
 * Hard-limit text with the explicit `…[truncated N characters]` marker.
 * @param text Text to limit.
 * @param limit Maximum length; callers pass at least MIN_RENDER_CHARS.
 * @returns Text no longer than limit (when limit allows the marker).
 */
function clipText(text, limit) {
  if (typeof text !== 'string') text = String(text)
  if (text.length <= limit) return text
  let keep = Math.max(0, limit - 48)
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const omitted = text.length - keep
    const marker = `…[truncated ${omitted} characters]`
    if (keep + marker.length <= limit) return text.slice(0, keep) + marker
    keep = Math.max(0, limit - marker.length)
  }
  const marker = `…[truncated ${text.length} characters]`
  if (marker.length >= limit) return text.slice(0, Math.max(0, limit))
  return text.slice(0, limit - marker.length) + marker
}
