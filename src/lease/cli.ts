/** `hyprscope control` command line: ask for control, hold it, and give it back. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { resolveLanguage } from '../i18n.ts'
import { hashDesktopConfig } from '../desktop/config.ts'
import { readDesktopRecord } from '../desktop/record.ts'
import { parseDesktopTarget, resolveTarget } from '../desktop/target.ts'
import type { DesktopTarget, ResolvedTarget } from '../desktop/types.ts'
import type { DesktopStatusReport } from '../desktop/lifecycle.ts'
import { installBind, uninstallBind } from './bind.ts'
import { leaseStatus, releaseLease } from './control.ts'
import { PLAN_LIMITS, planTextString } from '../plan/model.ts'

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version

const USAGE = `hyprscope control — ask the host for desktop control, then give it back

Usage: hyprscope control <command> [options]

Commands:
  run <plan.json | ->  Approve a plan, execute it under control, then release
  ops              List the supported ops and their fields (--json for the catalog)
  status           Print the current lease
  panic            Emergency release used by the failsafe shortcut; not an agent workflow step
  install-bind     Install the failsafe, desktop-message and desktop-annotate shortcuts into the Hyprland config
  uninstall-bind   Remove the managed shortcuts and the generated Lua file
  baseline         Measure this machine's capabilities and ask the host to accept them
  desktop          Start, attach, inspect, or stop an agent-dedicated desktop

Options:
  --desktop <t>     user (default), agent, or external
  --consent <secs>  How long the consent card waits (default 45)
  --key <combo>     Failsafe key for install-bind (default "SUPER + ALT + ESC")
  --message-key <combo>  Desktop-message key for install-bind (default "SUPER + ALT + M")
  --annotate-key <combo> Desktop-annotate key for install-bind (default "SUPER + ALT + A")
  --source <name>   Origin recorded in the lease (default: agent or host)
  --max-resumes <n> Recovery attempts one run may use (default 1, max 3)
  --dry-run         Validate the plan without asking
  --size <WxH>      desktop start: requested output size (default: parent window)
  --consent-source  desktop start/attach: chat (default) or card
  --lang <zh|en>    Language of the consent card and overlay (default: zh)
  --probe           baseline: measure, then ask the host to accept a widening result
  --show            baseline: print the accepted baseline and any pending draft
  --diff            baseline --show: compare the pending draft with the accepted one
  --read-only       baseline --probe: measure without dispatching or injecting
  --json            Machine-readable output
  -h, --help        Show this help
  -v, --version     Show the version
`

/** Parsed command line. */
export interface LeaseCliOptions {
  json: boolean
  help: boolean
  version: boolean
  consentSec?: number
  key?: string
  messageKey?: string
  annotateKey?: string
  source?: string
  desktop?: string
  runtimeDir?: string
  signature?: string
  size?: string
  consentSource?: string
  lang?: string
  dryRun?: boolean
  maxResumes?: number
  probe?: boolean
  show?: boolean
  diff?: boolean
  readOnly?: boolean
}

/** Output targets for one run. */
export interface Io {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Read the plan document for `run -`; defaults to process.stdin. */
  readStdin?: () => Promise<string>
}

/** Largest plan document accepted on stdin; bounds one submission. */
const MAX_PLAN_STDIN_BYTES = 1024 * 1024

/**
 * Read the whole stdin stream, refusing more than {@link MAX_PLAN_STDIN_BYTES}.
 * @param stream Input stream.
 * @returns UTF-8 text.
 */
function readStreamCapped(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_PLAN_STDIN_BYTES) {
        stream.destroy()
        reject(usage(`the plan on stdin must stay under ${MAX_PLAN_STDIN_BYTES} bytes`))
        return
      }
      chunks.push(buffer)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', (error: Error) => reject(new HyprscopeError(
      ErrorCode.COMMAND_FAILED, `Cannot read the plan from stdin: ${error.message}`,
    )))
  })
}

/**
 * Read the one-shot plan document submitted on stdin.
 * @param io Output targets.
 * @returns The submitted JSON text.
 */
async function readPlanInput(io: Io): Promise<string> {
  const text = await (io.readStdin ?? ((): Promise<string> => readStreamCapped(process.stdin)))()
  if (text.trim() === '') throw usage('run - needs a plan document on stdin')
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAN_STDIN_BYTES) {
    throw usage(`the plan on stdin must stay under ${MAX_PLAN_STDIN_BYTES} bytes`)
  }
  return text
}

const VALUE_OPTIONS: Record<string, keyof LeaseCliOptions> = {
  '--consent': 'consentSec', '--key': 'key', '--message-key': 'messageKey', '--annotate-key': 'annotateKey',
  '--source': 'source', '--max-resumes': 'maxResumes', '--desktop': 'desktop',
  '--runtime-dir': 'runtimeDir', '--signature': 'signature', '--size': 'size', '--consent-source': 'consentSource',
  '--lang': 'lang',
}
const FLAG_OPTIONS: Record<string, keyof LeaseCliOptions> = {
  '--json': 'json', '--help': 'help', '--version': 'version', '--dry-run': 'dryRun',
  '--probe': 'probe', '--show': 'show', '--diff': 'diff', '--read-only': 'readOnly',
}

/**
 * Build a usage failure.
 * @param message Reason.
 * @returns `USAGE` failure.
 */
function usage(message: string): HyprscopeError {
  return new HyprscopeError(ErrorCode.USAGE, message)
}

/**
 * Parse the desktop selector, defaulting to the user's desktop.
 * @param options Parsed options.
 * @returns Validated target.
 */
function targetOf(options: LeaseCliOptions): DesktopTarget {
  return parseDesktopTarget(options.desktop)
}

/**
 * Resolve a selector to a live session and its baseline key.
 * @param options Parsed options.
 * @param target Selector to resolve.
 * @returns Resolved target.
 */
async function resolveFor(options: LeaseCliOptions, target: DesktopTarget): Promise<ResolvedTarget> {
  return resolveTarget(target, {
    env: process.env, runtimeDir: options.runtimeDir, signature: options.signature,
  })
}

/**
 * Hash the generated configuration currently on disk.
 * @param resolved Target that may carry a config directory.
 * @returns Hash, or null when no configuration was generated.
 */
async function liveConfigHash(resolved: ResolvedTarget): Promise<string | null> {
  if (resolved.desktop === null || resolved.desktop.configDir === '') return null
  try {
    return await hashDesktopConfig(resolved.desktop.configDir)
  } catch {
    return null
  }
}

/**
 * Locate the baseline of a recorded desktop without requiring it to be running.
 * @param target Selector.
 * @returns Signature (null for the user's desktop) and the env that keys its lease.
 */
async function recordedTarget(target: DesktopTarget): Promise<{ signature: string | null; env: NodeJS.ProcessEnv }> {
  if (target === 'user') return { signature: null, env: process.env }
  const read = await readDesktopRecord()
  if (read.record === null || read.record.target !== target) {
    throw new HyprscopeError(ErrorCode.TARGET_UNAVAILABLE,
      target === 'agent'
        ? 'No agent desktop is recorded; run "hyprscope control desktop start" first'
        : 'No external desktop is attached; run "hyprscope control desktop attach" first',
      { record: read.path, warnings: read.warnings })
  }
  return {
    signature: read.record.signature,
    env: { ...process.env, HYPRSCOPE_LEASE_SIGNATURE: read.record.signature },
  }
}

/**
 * Render one lifecycle report.
 * @param report Status report.
 * @returns Human-readable lines.
 */
function renderDesktopStatus(report: DesktopStatusReport): string {
  const lines = [
    `desktop: ${report.state}${report.target === null ? '' : ` · ${report.target}`}`
      + `${report.signature === null ? '' : ` · ${report.signature}`}`,
  ]
  if (report.pid !== null) lines.push(`pid: ${report.pid}`)
  if (report.runtimeDir !== null) {
    lines.push(`runtime: ${report.runtimeDir}${report.waylandDisplay === null ? '' : ` · ${report.waylandDisplay}`}`)
  }
  lines.push(`baseline: ${report.baseline.present ? report.baseline.state ?? 'present' : 'none'} · ${report.baseline.file}`)
  if (report.configHash !== null) lines.push(`config: sha256 ${report.configHash.slice(0, 12)}`)
  if (report.detail !== null) lines.push(`detail: ${report.detail}`)
  return lines.join('\n')
}

/**
 * Parse command line arguments.
 * @param argv Arguments after the program name.
 * @returns Parsed input.
 */
export function parseLeaseArgs(argv: string[]): { options: LeaseCliOptions; command: string | undefined; args: string[] } {
  const options: LeaseCliOptions = { json: false, help: false, version: false }
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '-h') { options.help = true; continue }
    if (argument === '-v') { options.version = true; continue }
    // A lone dash is the stdin plan source, never an option.
    if (argument === '-') { positional.push(argument); continue }
    const separator = argument.startsWith('--') ? argument.indexOf('=') : -1
    const name = separator > 0 ? argument.slice(0, separator) : argument
    const inline = separator > 0 ? argument.slice(separator + 1) : undefined
    const flag = FLAG_OPTIONS[name]
    if (flag !== undefined) {
      if (inline !== undefined) throw usage(`${name} takes no value`)
      ;(options as unknown as Record<string, unknown>)[flag] = true
      continue
    }
    const valueKey = VALUE_OPTIONS[name]
    if (valueKey !== undefined) {
      const value = inline ?? argv[++index]
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        throw usage(`Expected a value after ${name}`)
      }
      ;(options as unknown as Record<string, unknown>)[valueKey] = value
      continue
    }
    if (argument.startsWith('-')) throw usage(`Unknown option ${argument}`)
    positional.push(argument)
  }
  if (typeof options.maxResumes === 'string' || typeof options.maxResumes === 'number') {
    const resumes = Number.parseInt(String(options.maxResumes), 10)
    if (!Number.isSafeInteger(resumes) || resumes < 0 || resumes > PLAN_LIMITS.maxResumes) {
      throw usage(`--max-resumes expects 0..${PLAN_LIMITS.maxResumes}`)
    }
    options.maxResumes = resumes
  }
  if (typeof options.consentSec === 'string') {
    const seconds = Number.parseInt(options.consentSec, 10)
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw usage('--consent expects positive seconds')
    options.consentSec = seconds
  }
  return { options, command: positional[0], args: positional.slice(1) }
}

/**
 * Write one value, either as JSON or through a human renderer.
 * @param io Output targets.
 * @param value Value to print.
 * @param json Whether JSON was requested.
 * @param render Human renderer.
 */
function print<T>(io: Io, value: T, json: boolean, render: (value: T) => string): void {
  io.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${render(value)}\n`)
}

/**
 * Report a failure and pick the exit code.
 * @param io Error target.
 * @param error Failure to report.
 * @param json Whether JSON was requested.
 * @returns Process exit code.
 */
function fail(io: Io, error: unknown, json: boolean): number {
  const failure = error instanceof HyprscopeError ? error
    : new HyprscopeError(ErrorCode.COMMAND_FAILED, error instanceof Error ? error.message : String(error))
  if (json) {
    io.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message, details: failure.details } })}\n`)
  } else {
    io.stderr.write(`hyprscope: ${failure.code}: ${failure.message}\n`)
  }
  return failure.code === ErrorCode.USAGE ? 2 : 1
}

/**
 * Run one command.
 * @param argv Arguments after the program name.
 * @param io Output targets.
 * @returns Process exit code.
 */
export async function main(argv: string[], io: Io = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  let parsed: ReturnType<typeof parseLeaseArgs>
  try {
    parsed = parseLeaseArgs(argv)
  } catch (error) {
    return fail(io, error, false)
  }
  const { options, command } = parsed
  if (options.version) {
    io.stdout.write(`hyprscope ${VERSION}\n`)
    return 0
  }
  if (options.help || command === undefined) {
    if (command === undefined && !options.help) {
      io.stderr.write(USAGE)
      return 2
    }
    io.stdout.write(USAGE)
    return 0
  }
  try {
    switch (command) {
      case 'ops': {
        if (parsed.args.length > 0) throw usage('ops takes no arguments besides --json')
        const { listOps, renderOps } = await import('../plan/ops.ts')
        print(io, listOps(), options.json, () => renderOps())
        return 0
      }
      case 'run': {
        const file = parsed.args[0]
        if (file === undefined) throw usage('run requires a plan file or - for stdin')
        const { checkPlan, loadPlan, loadPlanText, previewPlan, runPlanFile } = await import('../plan/run.ts')
        // The plan arrives once and is loaded once: from a file, or from stdin
        // for a one-shot submission. Nothing is written to disk on the way in.
        const source = file === '-'
          ? { text: await readPlanInput(io) }
          : { file }
        if (options.dryRun === true) {
          const plan = source.text === undefined
            ? await loadPlan(source.file)
            : loadPlanText(source.text, 'Plan input')
          // The report is machine-readable and keeps authored text as one
          // string: a localized reason or summary resolves English first, then
          // Chinese. The consent card keeps its per-language rendering.
          const reported = {
            ...plan,
            reason: planTextString(plan.reason),
            summary: plan.summary === null ? null : planTextString(plan.summary),
          }
          const preview = previewPlan(reported)
          // Refuse a doomed plan before it ever reaches a consent card.
          const check = await checkPlan(plan, { desktop: targetOf(options) })
          print(io, {
            ...preview,
            target: { kind: check.target.target, signature: check.target.session.signature },
            baseline: check.baselineReceipt,
            staleness: check.staleness.verdict,
          }, options.json, value => [
            `plan ${value.plan.id} · ${value.summary.steps} steps · budget ${value.plan.budgetMs}ms`,
            `target: ${value.target.kind} · ${value.target.signature}`,
            `baseline: ${value.baseline.state} · ${value.staleness} · approved ${value.baseline.approvedAt}`,
            `ops: ${value.summary.ops.join(', ')}`,
            `reason: ${value.plan.reason}`,
            `recovery: up to ${options.maxResumes ?? PLAN_LIMITS.defaultMaxResumes} attempt(s), each gets its own budget`,
            'no consent requested (--dry-run)',
          ].join('\n'))
          return 0
        }
        const result = await runPlanFile({
          ...source,
          desktop: targetOf(options),
          consentMs: options.consentSec === undefined ? undefined : options.consentSec * 1000,
          maxResumes: options.maxResumes,
          lang: resolveLanguage(options.lang),
        })
        print(io, result, options.json, value => {
          const resumed = value.attempts.length > 1 ? ` · ${value.attempts.length - 1} recovery attempt${value.attempts.length > 2 ? 's' : ''}` : ''
          return value.status === 'completed'
            ? `completed · ${value.steps.length} steps${resumed} · ${value.durationMs}ms · ${value.dir}`
            : `${value.status} at step ${value.fault?.step ?? '?'} · ${value.fault?.broken.kind ?? 'unknown'}`
              + ` · committed [${value.fault?.committed.join(', ') ?? ''}]${resumed} · ${value.dir}`
        })
        return result.status === 'completed' ? 0 : 1
      }
      case 'status': {
        const env = options.desktop === undefined ? process.env : (await resolveFor(options, targetOf(options))).env
        print(io, await leaseStatus(env), options.json, value => value.active
          ? `active · ${value.phase} · lease ${value.leaseId}`
            + `${value.grantedBy ? ` · approved by ${value.grantedBy}` : ''}`
            + ` · remaining ${Math.ceil((value.remainingMs ?? 0) / 1000)}s`
            + (value.attempt > 0 ? ` · recovery ${value.attempt}/${value.maxResumes}` : '')
            + `${value.stale ? ' · STALE' : ''}`
          : `idle${value.phase === null ? '' : ` · last phase ${value.phase}`}`)
        return 0
      }
      case 'panic': {
        const env = options.desktop === undefined ? process.env : (await resolveFor(options, targetOf(options))).env
        print(io, await releaseLease({ action: 'panic', source: options.source, env }), options.json,
          value => `${value.action}: ${value.ok ? 'released' : 'no active lease'}${value.forced ? ' (forced)' : ''}`)
        return 0
      }
      case 'install-bind': {
        if (targetOf(options) !== 'user') throw usage('install-bind only applies to the user\'s desktop')
        const user = await resolveFor(options, 'user')
        const result = await installBind({
          key: options.key,
          messageKey: options.messageKey,
          annotateKey: options.annotateKey,
          session: user.session,
        })
        print(io, result, options.json, value => `installed failsafe ${value.key} → ${value.command}`
          + `\ninstalled desktop message ${value.messageKey} → ${value.messageCommand}`
          + `\ninstalled desktop annotate ${value.annotateKey} → ${value.annotateCommand}`
          + `\nshortcut recorded in ${value.shortcutFile}`
          + `\nannotate shortcut recorded in ${value.annotateShortcutFile}`
          + `${value.verified && value.messageVerified && value.annotateVerified
            ? ''
            : ' (not all binds were observed in hyprctl binds — check the config)'}`)
        return 0
      }
      case 'uninstall-bind': {
        if (targetOf(options) !== 'user') throw usage('uninstall-bind only applies to the user\'s desktop')
        const user = await resolveFor(options, 'user')
        const result = await uninstallBind({ session: user.session })
        print(io, result, options.json, value => value.removed ? 'removed the managed hyprscope shortcuts' : 'no hyprscope block found')
        return 0
      }
      case 'baseline': {
        if (options.probe === true && options.show === true) throw usage('baseline takes only one of --probe or --show')
        const action = options.probe === true ? 'probe' : 'show'
        if (options.diff === true && action !== 'show') throw usage('--diff is only valid with --show')
        if (options.readOnly === true && action !== 'probe') throw usage('--read-only is only valid with --probe')
        const {
          acceptBaseline, probeBaseline, renderBaselineProbe, renderBaselineShow, showBaseline,
        } = await import('./baseline.ts')
        const target = targetOf(options)
        const lang = resolveLanguage(options.lang)
        if (action === 'probe') {
          const resolved = await resolveFor(options, target)
          const liveHash = await liveConfigHash(resolved)
          // A generated desktop only measures what it is running. Editing a
          // snippet changes the files but not the compositor, so a probe now
          // would attest a configuration that is not in effect.
          if (resolved.desktop !== null && resolved.desktop.configDir !== '') {
            if (liveHash === null) {
              throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
                'The desktop configuration could not be read; stop and start the desktop before probing it',
                { configDir: resolved.desktop.configDir })
            }
            if (resolved.desktop.configHash !== null && liveHash !== resolved.desktop.configHash) {
              throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
                'The desktop configuration changed since it started; stop and start the desktop before probing it',
                { recorded: resolved.desktop.configHash, observed: liveHash })
            }
          }
          // The probe checks the failsafe bind by reading the Lua config and the
          // bind list. Inside the generated desktop both are the desktop's own,
          // not the user's ~/.config/hypr.
          const probeEnv = target === 'agent' && resolved.desktop !== null
            ? { ...resolved.env, HYPR_CONFIG_DIR: join(resolved.desktop.configDir, 'hypr') }
            : resolved.env
          let report = await probeBaseline({
            consentMs: options.consentSec === undefined ? undefined : options.consentSec * 1000,
            readOnly: options.readOnly === true,
            signature: resolved.baselineSignature,
            target,
            session: resolved.session,
            configHash: liveHash,
            consent: target === 'user' ? 'card' : 'programmatic',
            env: probeEnv,
            lang,
          })
          // A widening result is this command's request: the same process shows
          // the host's confirmation card and continues with the answer, so no
          // separate CLI entry can accept a draft on the host's behalf.
          if (report.applied === 'pending') {
            try {
              const accepted = await acceptBaseline({
                signature: resolved.baselineSignature,
                target,
                lang,
                consentMs: options.consentSec === undefined ? undefined : options.consentSec * 1000,
              })
              report = {
                ...report,
                applied: 'accepted',
                path: accepted.path,
                state: accepted.state,
                accept: accepted,
                confirmation: { approved: true, phase: 'released', source: accepted.source },
              }
            } catch (error) {
              if (!(error instanceof HyprscopeError) || error.code !== ErrorCode.DENIED) throw error
              report = {
                ...report,
                confirmation: {
                  approved: false,
                  phase: typeof error.details.phase === 'string' ? error.details.phase : 'denied',
                  source: typeof error.details.source === 'string' ? error.details.source : 'overlay',
                },
              }
            }
          }
          print(io, report, options.json, renderBaselineProbe)
          return 0
        }
        const recorded = await recordedTarget(target)
        print(io, await showBaseline({ signature: recorded.signature, target, diff: options.diff === true }),
          options.json, renderBaselineShow)
        return 0
      }
      case 'desktop': {
        const action = parsed.args[0]
        if (options.consentSource !== undefined && options.consentSource !== 'chat' && options.consentSource !== 'card') {
          throw usage('--consent-source expects chat or card')
        }
        const consent = options.consentSource === 'card' ? 'card' : 'chat'
        const { attachDesktop, startDesktop, statusDesktop, stopDesktop } = await import('../desktop/lifecycle.ts')
        if (action === 'start') {
          if (options.desktop !== undefined && targetOf(options) !== 'agent') {
            throw usage('desktop start creates an agent desktop; omit --desktop')
          }
          const report = await startDesktop({ size: options.size, consent, env: process.env })
          print(io, report, options.json, renderDesktopStatus)
          return report.state === 'running' ? 0 : 1
        }
        if (action === 'status') {
          print(io, await statusDesktop(process.env), options.json, renderDesktopStatus)
          return 0
        }
        if (action === 'stop') {
          const report = await stopDesktop({ env: process.env })
          print(io, report, options.json, value => `desktop: ${value.state}`
            + `${value.signature === null ? '' : ` · ${value.signature}`}`
            + ` · runtime ${value.removed ? 'removed' : 'kept'}`
            + `${value.detail === null ? '' : ` · ${value.detail}`}`)
          return 0
        }
        if (action === 'attach') {
          if (options.desktop !== undefined && targetOf(options) !== 'external') {
            throw usage('desktop attach records an external desktop; omit --desktop')
          }
          if (options.runtimeDir === undefined) throw usage('desktop attach requires --runtime-dir <dir>')
          const report = await attachDesktop({
            runtimeDir: options.runtimeDir, signature: options.signature, consent, env: process.env,
          })
          print(io, report, options.json, renderDesktopStatus)
          return 0
        }
        throw usage('desktop expects start, attach, status, or stop')
      }
      default:
        throw usage(`Unknown command ${command}`)
    }
  } catch (error) {
    return fail(io, error, options.json)
  }
}
