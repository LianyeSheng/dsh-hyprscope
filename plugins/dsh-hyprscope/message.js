/**
 * Desktop-message bridge: the Host half of the floating hint and shortcut.
 *
 * The Quickshell overlay (overlay/message) owns every pixel and writes one JSON
 * document per composed message into \`<messageDir>/outbox\`. This module owns the
 * other half: it keeps \`status.json\` fresh so the hint knows the Host is alive,
 * starts the overlay through the CLI once a Hyprland session is reachable, and
 * turns each outbox document into a user message in the most recently active
 * root session. A message may carry a screenshot of the desktop at that moment.
 *
 * It is deliberately thin and duck-typed: the CLI owns session discovery and the
 * overlay, and the Host's public \`sessionController\` owns prompt admission and
 * Session resumption. This file imports no repository code and no DSH package.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Version of the status-file contract the overlay reads. */
const STATUS_VERSION = 1

/** How often the outbox is scanned for a composed message. */
const POLL_MS = 200

/** How often status.json is refreshed; the overlay treats a stale one as gone. */
const HEARTBEAT_MS = 5_000

/** Delay between the overlay hiding its surface and the screenshot. */
const SCREENSHOT_DELAY_MS = 180

/** Refuse a screenshot larger than this; a prompt image must stay sane. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Refuse a composed message longer than this many characters. */
const MAX_TEXT_CHARS = 8_000

/** Overlay start retry delays after a failed spawn, in milliseconds. */
const OVERLAY_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000]

/**
 * Resolve the directory the CLI and this bridge share.
 * @param {object} settings Validated plugin settings.
 * @returns {string} Absolute directory path.
 */
export function messageDirectory(settings) {
  if (typeof settings.messageDir === 'string' && settings.messageDir !== '') return settings.messageDir
  const override = process.env.HYPRSCOPE_MESSAGE_DIR
  if (typeof override === 'string' && override.trim() !== '') return resolve(override)
  const base = process.env.XDG_STATE_HOME !== undefined && process.env.XDG_STATE_HOME !== ''
    ? process.env.XDG_STATE_HOME
    : join(process.env.HOME ?? homedir(), '.local', 'state')
  return join(base, 'hyprscope', 'message')
}

/**
 * Write one JSON document atomically through a sibling temp file.
 * @param {string} path Destination path.
 * @param {unknown} value JSON value.
 */
async function writeJsonAtomic(path, value) {
  const temporary = path + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex')
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * @param {unknown} value Candidate.
 * @returns {boolean} Whether the value is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Start the desktop-message bridge.
 *
 * The returned object is created synchronously; \`ready\` settles after the first
 * status write and overlay attempt, and every failure is contained: a bridge
 * that cannot start must never fail plugin activation or disable the tools.
 * @param {object} options Host context, validated settings, and the plugin's CLI runner.
 * @returns {{ ready: Promise<void>, dispose: () => Promise<void> }} Bridge handle.
 */
export function startDesktopMessageBridge(options) {
  const { ctx, settings, runCli } = options
  const dir = messageDirectory(settings)
  const paths = {
    dir,
    statusFile: join(dir, 'status.json'),
    ackFile: join(dir, 'ack.json'),
    outboxDir: join(dir, 'outbox'),
    lastSessionFile: join(dir, 'last-session.json'),
  }
  const language = settings.messageLanguage === 'en' ? 'en' : 'zh'
  const state = {
    disposed: false,
    lastSessionId: null,
    polling: false,
    overlayReady: false,
    overlayBusy: false,
    overlayPid: null,
    overlayAttempts: 0,
    nextOverlayAt: 0,
    statusError: null,
  }
  let pollTimer = null
  let heartbeatTimer = null

  /**
   * Log through the Host logger when it exists.
   * @param {string} message Warning text.
   */
  const warn = (message) => {
    try {
      if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('hyprscope message: ' + message)
      }
    } catch {
      // A logger that refuses a line must not break the bridge.
    }
  }

  /**
   * @param {object} fields Status overrides.
   * @returns {object} Complete status record.
   */
  const statusRecord = (fields) => Object.assign({
    version: STATUS_VERSION,
    alive: true,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    language,
    attachScreenshot: settings.messageAttachScreenshot !== false,
    sessionId: state.lastSessionId,
    error: state.statusError,
  }, fields)

  /** Write the heartbeat; a failed write is reported once through the log. */
  const writeStatus = async () => {
    if (state.disposed) return
    try {
      await writeJsonAtomic(paths.statusFile, statusRecord({}))
    } catch (error) {
      state.statusError = 'cannot write ' + paths.statusFile + ': '
        + (error instanceof Error ? error.message : String(error))
      warn(state.statusError)
    }
  }

  /** Read the last root Session id recorded by a previous Host. */
  const loadLastSession = async () => {
    try {
      const parsed = JSON.parse(await readFile(paths.lastSessionFile, 'utf8'))
      if (isRecord(parsed) && typeof parsed.sessionId === 'string') state.lastSessionId = parsed.sessionId
    } catch {
      // A missing or malformed record simply means "no remembered Session".
    }
  }

  /** Persist the last root Session id; a failure is not fatal. */
  const saveLastSession = async () => {
    if (state.lastSessionId === null) return
    try {
      await writeJsonAtomic(paths.lastSessionFile, {
        sessionId: state.lastSessionId,
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      warn('cannot record the last Session: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * Remember a root Session. Subagent Sessions never become the desktop target.
   * @param {unknown} session Session that emitted an event.
   */
  const trackSession = (session) => {
    if (state.disposed || !isRecord(session)) return
    const header = isRecord(session.header) ? session.header : null
    if (header === null || typeof header.id !== 'string') return
    if (header.origin === 'subagent') return
    if (state.lastSessionId === header.id) return
    state.lastSessionId = header.id
    void saveLastSession()
  }

  // A live event listener is the cheapest way to know the conversation the user
  // is in; a cordis fiber disposes it with the plugin. Fake-test contexts may
  // omit either method, and the bridge still falls back to list/create.
  try {
    if (typeof ctx.on === 'function') {
      const remove = ctx.on('session/event', (session) => { trackSession(session) })
      if (typeof remove === 'function' && typeof ctx.effect === 'function') ctx.effect(() => remove)
    }
  } catch (error) {
    warn('cannot observe Session activity: ' + (error instanceof Error ? error.message : String(error)))
  }

  /**
   * @returns {object | null} The live session controller, when the profile has one.
   */
  const sessionController = () => {
    try {
      const controller = ctx.get('sessionController')
      return isRecord(controller) ? controller : null
    } catch {
      return null
    }
  }

  /**
   * @returns {Promise<string | null>} The most recently active visible Session.
   */
  const newestVisibleSession = async () => {
    const controller = sessionController()
    if (controller === null || typeof controller.list !== 'function') return null
    try {
      const value = await controller.list({}, AbortSignal.timeout(5_000))
      const items = isRecord(value) && Array.isArray(value.items) ? value.items : []
      const first = items.find(item => isRecord(item) && typeof item.sessionId === 'string'
        && item.origin !== 'subagent')
      return first !== undefined && typeof first.sessionId === 'string' ? first.sessionId : null
    } catch {
      return null
    }
  }

  /**
   * @returns {Promise<string | null>} A newly created Session identity.
   */
  const createSession = async () => {
    const controller = sessionController()
    if (controller === null || typeof controller.create !== 'function') return null
    try {
      const value = await controller.create({})
      return isRecord(value) && typeof value.sessionId === 'string' ? value.sessionId : null
    } catch {
      return null
    }
  }

  /**
   * Resolve the target Session: the pinned id, the remembered conversation, the
   * most recent visible one, or a new one. Creating is the last resort so a
   * desktop message is never lost just because the Host restarted.
   * @param {boolean} fresh Skip the remembered id (it may no longer exist).
   * @returns {Promise<string>} Target Session identity.
   */
  const resolveTarget = async (fresh = false) => {
    if (fresh === false && typeof settings.messageSessionId === 'string'
      && settings.messageSessionId !== '') return settings.messageSessionId
    if (fresh === false && state.lastSessionId !== null) return state.lastSessionId
    const listed = await newestVisibleSession()
    if (listed !== null) return listed
    const created = await createSession()
    if (created !== null) return created
    throw new Error('the DSH Host exposes no usable sessionController; the desktop message bridge needs the Web or Desktop profile')
  }

  /**
   * Capture the layout once. A capture failure is a text-only message, never a
   * lost message.
   * @returns {Promise<object | null>} Inline image part.
   */
  const captureImage = async () => {
    try {
      await new Promise(resolve => { setTimeout(resolve, SCREENSHOT_DELAY_MS) })
      await mkdir(settings.screenshotDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const output = join(settings.screenshotDir,
        'desktop-message-' + stamp + '-' + randomBytes(3).toString('hex') + '.png')
      const result = await runCli(['screenshot', '--output', output], {
        timeoutMs: settings.timeoutMs + 5_000,
        env: Object.assign({}, process.env, { HYPRSCOPE_MESSAGE_DIR: paths.dir }),
      })
      if (result.code !== 0) return null
      const parsed = JSON.parse(result.stdout)
      const path = isRecord(parsed) && typeof parsed.path === 'string' ? parsed.path : output
      const bytes = await readFile(path)
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
      return { mediaType: 'image/png', data: bytes.toString('base64'), name: basename(path) }
    } catch {
      return null
    }
  }

  /**
   * Admit one prompt through the Host's public session controller.
   * @param {string} sessionId Target Session.
   * @param {Array<object>} content Prompt content blocks.
   * @param {string} requestId Idempotent request identity.
   */
  const prompt = async (sessionId, content, requestId) => {
    const controller = sessionController()
    if (controller === null || typeof controller.prompt !== 'function') {
      throw new Error('the DSH Host exposes no sessionController.prompt; the Web or Desktop profile provides it')
    }
    await controller.prompt({ requestId, sessionId, mode: 'queue', content },
      AbortSignal.timeout(settings.controlTimeoutMs ?? 120_000))
  }

  /**
   * Deliver one composed message, including its optional screenshot.
   * @param {{id: string, text: string}} message Composed message.
   * @returns {Promise<{sessionId: string, attached: boolean}>} Delivery facts.
   */
  const deliver = async (message) => {
    const text = message.text.slice(0, MAX_TEXT_CHARS)
    const image = settings.messageAttachScreenshot === false ? null : await captureImage()
    const textPart = { type: 'text', text }
    const content = image === null ? [textPart] : [textPart, Object.assign({ type: 'image' }, image)]
    const requestId = 'desktop-' + message.id
    const sessionId = await resolveTarget()
    try {
      await prompt(sessionId, content, requestId)
      return { sessionId, attached: image !== null }
    } catch (firstError) {
      // An image the route cannot read (or a Session that moved on) must not
      // discard the user's text. A pinned Session is never replaced: retrying
      // there is the only safe behavior when the configuration names it.
      try {
        const pinned = typeof settings.messageSessionId === 'string' && settings.messageSessionId !== ''
        const retryTarget = pinned ? sessionId : await resolveTarget(true)
        await prompt(retryTarget, [textPart], requestId)
        return { sessionId: retryTarget, attached: false }
      } catch {
        throw firstError
      }
    }
  }

  /**
   * Handle one outbox document: consume it exactly once, then acknowledge.
   * @param {string} name Outbox file name.
   */
  const consume = async (name) => {
    const path = join(paths.outboxDir, name)
    let message
    try {
      message = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      await unlink(path).catch(() => {})
      await writeJsonAtomic(paths.ackFile, {
        id: name,
        ok: false,
        message: 'cannot read the composed message: ' + (error instanceof Error ? error.message : String(error)),
        sessionId: null,
        at: new Date().toISOString(),
      })
      return
    }
    // Consume before delivery: a Host crash must not deliver twice.
    await unlink(path).catch(() => {})
    if (!isRecord(message) || typeof message.id !== 'string' || typeof message.text !== 'string'
      || message.text.trim() === '') {
      await writeJsonAtomic(paths.ackFile, {
        id: isRecord(message) && typeof message.id === 'string' ? message.id : name,
        ok: false,
        message: 'the composed message carried no text',
        sessionId: null,
        at: new Date().toISOString(),
      })
      return
    }
    try {
      const delivered = await deliver({ id: message.id, text: message.text.trim() })
      state.lastSessionId = delivered.sessionId
      state.statusError = null
      await saveLastSession()
      await writeStatus()
      await writeJsonAtomic(paths.ackFile, {
        id: message.id,
        ok: true,
        message: delivered.attached ? null : 'sent without the desktop screenshot',
        sessionId: delivered.sessionId,
        at: new Date().toISOString(),
      })
    } catch (error) {
      await writeJsonAtomic(paths.ackFile, {
        id: message.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        sessionId: null,
        at: new Date().toISOString(),
      })
    }
  }

  /** Scan the outbox once; a second scan never overlaps the first. */
  const poll = async () => {
    if (state.disposed || state.polling) return
    state.polling = true
    try {
      const names = (await readdir(paths.outboxDir)).filter(name => /^msg-.+\.json$/.test(name)).sort()
      for (const name of names) {
        if (state.disposed) return
        await consume(name)
      }
    } catch {
      // A missing outbox is recreated on the next start; polling continues.
    } finally {
      state.polling = false
    }
  }

  /**
   * @param {number} pid Candidate overlay process.
   * @returns {Promise<boolean>} Whether /proc still reports a Quickshell process.
   */
  const overlayAlive = async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      const comm = (await readFile('/proc/' + pid + '/comm', 'utf8')).trim().toLowerCase()
      return comm === 'quickshell' || comm === 'qs'
    } catch {
      return false
    }
  }

  /** Start (or retry starting) the overlay through the CLI. */
  const ensureOverlay = async () => {
    if (state.disposed || state.overlayReady || state.overlayBusy) return
    if (Date.now() < state.nextOverlayAt) return
    state.overlayBusy = true
    state.overlayAttempts += 1
    try {
      const result = await runCli(['message', 'overlay', '--lang', language], {
        timeoutMs: settings.timeoutMs + 10_000,
        env: Object.assign({}, process.env, { HYPRSCOPE_MESSAGE_DIR: paths.dir }),
      })
      if (state.disposed) return
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'exit ' + result.code)
      // A spawned CLI is not a rendered overlay: give Quickshell a moment and
      // require the pid it reported to still exist. A QML or import failure
      // otherwise looks like success forever.
      let pid = null
      try {
        const parsed = JSON.parse(result.stdout)
        pid = isRecord(parsed) && isRecord(parsed.overlay) ? parsed.overlay.pid : null
      } catch {
        // Older CLI output without a parsed overlay keeps the best-effort path.
      }
      if (typeof pid === 'number') {
        await new Promise(resolveWait => { setTimeout(resolveWait, 600) })
        if (state.disposed) return
        if (!(await overlayAlive(pid))) throw new Error('the overlay process exited right after it started')
        state.overlayPid = pid
      }
      state.overlayReady = true
      state.statusError = null
    } catch (error) {
      state.statusError = 'cannot start the desktop-message overlay: '
        + (error instanceof Error ? error.message : String(error))
      const index = Math.min(state.overlayAttempts - 1, OVERLAY_RETRY_MS.length - 1)
      state.nextOverlayAt = Date.now() + OVERLAY_RETRY_MS[index]
      warn(state.statusError)
    } finally {
      state.overlayBusy = false
    }
    await writeStatus()
  }

  /** Restart an overlay that died after a successful start, then keep trying. */
  const maintainOverlay = async () => {
    if (state.disposed) return
    if (state.overlayReady && state.overlayPid !== null && !(await overlayAlive(state.overlayPid))) {
      state.overlayReady = false
      state.overlayPid = null
      state.nextOverlayAt = 0
      warn('the desktop-message overlay exited; starting it again')
    }
    await ensureOverlay()
  }

  /**
   * Stop timers, stop reporting liveness, and close the overlay politely.
   * @returns {Promise<void>} Completion after the final status write.
   */
  const dispose = async () => {
    if (state.disposed) return
    state.disposed = true
    if (pollTimer !== null) clearInterval(pollTimer)
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
    pollTimer = null
    heartbeatTimer = null
    // An in-flight spawn or delivery must not outlive the Host: wait briefly for
    // it, then continue with the final status and the overlay stop request.
    const settleDeadline = Date.now() + 3_000
    while ((state.overlayBusy || state.polling) && Date.now() < settleDeadline) {
      await new Promise(resolveWait => { setTimeout(resolveWait, 50) })
    }
    try {
      await writeJsonAtomic(paths.statusFile, statusRecord({ alive: false, updatedAt: new Date().toISOString() }))
    } catch {
      // The Host is going away; a final status is best-effort.
    }
    try {
      await runCli(['message', 'stop'], {
        timeoutMs: 5_000,
        env: Object.assign({}, process.env, { HYPRSCOPE_MESSAGE_DIR: paths.dir }),
      })
    } catch {
      // Nothing is left to report to.
    }
  }

  const ready = (async () => {
    try {
      await mkdir(paths.outboxDir, { recursive: true, mode: 0o700 })
      await loadLastSession()
    } catch (error) {
      warn('cannot prepare ' + paths.dir + ': ' + (error instanceof Error ? error.message : String(error)))
      return
    }
    await writeStatus()
    await ensureOverlay()
    if (state.disposed) return
    pollTimer = setInterval(() => { void poll() }, POLL_MS)
    if (pollTimer !== null && typeof pollTimer.unref === 'function') pollTimer.unref()
    heartbeatTimer = setInterval(() => {
      if (state.disposed) return
      void writeStatus()
      void maintainOverlay()
    }, HEARTBEAT_MS)
    if (heartbeatTimer !== null && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
    // A message composed just before a Host restart is still delivered.
    void poll()
  })().catch((error) => {
    warn('bridge startup failed: ' + (error instanceof Error ? error.message : String(error)))
  })

  return { ready, dispose }
}
