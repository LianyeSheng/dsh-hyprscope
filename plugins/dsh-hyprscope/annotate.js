/**
 * Desktop annotation bridge: the Host half of the visual + voice input surface.
 *
 * The Quickshell annotate overlay (overlay/message/AnnotateSurface.qml) shows a
 * frozen screenshot and lets the user point at things and talk. This module owns
 * the other half: it captures the cursor monitor and the window metadata through
 * the read-only CLI, records the microphone, transcribes push-to-talk segments
 * with the Host speech service, aligns speech with annotations, compiles the
 * intent card and admits it as one user message with the clean screenshot.
 *
 * It imports no DSH package and no repository code, and every helper that does
 * real work is exported so tests can drive it without a live compositor.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeWav, linkVoiceToAnnotations, slicePcm, splitPhrases } from './voice.js'

/** Version of the annotate session contract written by this module. */
const SESSION_VERSION = 1

/** How often the session directory is scanned for voice, send and cancel files. */
const POLL_MS = 200

/** Refuse a screenshot larger than this; a prompt image must stay sane. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Refuse an intent card longer than this many characters. */
const MAX_TEXT_CHARS = 8_000

/** Keep the window list readable for the agent. */
const MAX_WINDOWS = 24

/** Hard cap for one push-to-talk segment, matching the overlay behaviour. */
const MAX_SEGMENT_MS = 60_000

/** One transcription call may not hang the session. */
const TRANSCRIBE_TIMEOUT_MS = 30_000

/** Give the transcription queue this long to settle before sending. */
const QUEUE_SETTLE_MS = 6_000

/** 16 kHz mono s16le is 32000 bytes per second, i.e. 32 bytes per millisecond. */
const BYTES_PER_MS = 32

/** An annotate request older than this is a leftover from a previous Host, not a new trigger. */
const REQUEST_FRESH_MS = 60_000

/**
 * @param {unknown} value Candidate.
 * @returns {boolean} Whether the value is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build a session identity from the trigger instant.
 * @param {Date} now Trigger time.
 * @returns {string} Compact ISO stamp plus four random hex digits.
 */
export function sessionIdFor(now) {
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')
  return stamp + '-' + randomBytes(2).toString('hex')
}

/**
 * Pick the monitor under the pointer, falling back to the focused one.
 * @param {object} state Parsed "hyprscope state --json" output.
 * @returns {object | null} Monitor record with name, position, size, scale, transform.
 */
export function pickMonitor(state) {
  if (!isRecord(state) || !Array.isArray(state.monitors)) return null
  const cursor = isRecord(state.cursor) ? state.cursor : null
  const monitors = state.monitors.filter(isRecord)
  const inner = (monitor) => {
    const position = isRecord(monitor.position) ? monitor.position : { x: 0, y: 0 }
    const size = isRecord(monitor.size) ? monitor.size : { width: 0, height: 0 }
    if (cursor === null) return false
    return cursor.x >= position.x && cursor.y >= position.y
      && cursor.x < position.x + size.width && cursor.y < position.y + size.height
  }
  return monitors.find(inner) ?? monitors.find(monitor => monitor.focused === true) ?? monitors[0] ?? null
}

/**
 * Normalize one Hyprland client into the contract window shape.
 * @param {object} client Raw client record.
 * @param {string | null} focusedId Focused window identity.
 * @returns {object} Contract window record.
 */
function normalizeWindow(client, focusedId) {
  const position = isRecord(client.position) ? client.position : { x: 0, y: 0 }
  const size = isRecord(client.size) ? client.size : { width: 0, height: 0 }
  const workspace = isRecord(client.workspace) ? client.workspace : { id: 0, name: '' }
  return {
    id: typeof client.windowId === 'string' ? client.windowId : '',
    class: typeof client.app === 'string' ? client.app : '',
    title: typeof client.title === 'string' ? client.title : '',
    pid: typeof client.pid === 'number' ? client.pid : 0,
    rect: [position.x, position.y, size.width, size.height],
    workspace: typeof workspace.id === 'number' ? workspace.id : 0,
    monitor: typeof client.monitor === 'number' ? client.monitor : 0,
    focused: typeof client.windowId === 'string' && client.windowId === focusedId,
    floating: client.floating === true,
  }
}

/**
 * Windows that intersect the captured layout rectangle, bottom to top.
 * @param {object} state Parsed "hyprscope state --json" output.
 * @param {number[]} region Layout rectangle [x, y, width, height].
 * @param {string | null} focusedId Focused window identity.
 * @returns {object[]} At most MAX_WINDOWS contract window records.
 */
export function windowsFor(state, region, focusedId) {
  if (!isRecord(state) || !Array.isArray(state.clients)) return []
  const [x, y, width, height] = region
  const intersecting = state.clients.filter(isRecord).filter((client) => {
    const position = isRecord(client.position) ? client.position : null
    const size = isRecord(client.size) ? client.size : null
    if (position === null || size === null) return false
    if (size.width <= 0 || size.height <= 0) return false
    return position.x < x + width && position.x + size.width > x
      && position.y < y + height && position.y + size.height > y
  })
  const mapped = intersecting.filter(client => client.mapped !== false)
  const kept = (mapped.length > 0 ? mapped : intersecting).slice(-MAX_WINDOWS)
  return kept.map(client => normalizeWindow(client, focusedId))
}

/**
 * Format milliseconds since the session start as a compact seconds label.
 * @param {number} at Absolute epoch milliseconds.
 * @param {number} startedAt Session start epoch milliseconds.
 * @returns {string} Label such as "3.2s".
 */
export function relativeLabel(at, startedAt) {
  const delta = (at - startedAt) / 1000
  return (Math.round(delta * 10) / 10).toFixed(1) + 's'
}

/**
 * Compose the intent card that the agent reads above the screenshot.
 *
 * The card is deterministic and testable: it never reads files and never calls
 * the Host. Geometry stays in image pixels with the screen equivalent alongside,
 * and every speech segment is tied to the annotations it overlaps.
 * @param {object} input Session, annotations, phrases, links and language.
 * @returns {string} Prompt text capped at MAX_TEXT_CHARS.
 */
export function composeIntentCard(input) {
  const { session, annotations, phrases, links, language, overallNote } = input
  const chinese = language !== 'en'
  const capture = session.capture
  const scale = typeof capture.scale === 'number' && capture.scale > 0 ? capture.scale : 1
  const lines = []
  lines.push(chinese
    ? '[hyprscope 桌面标注] 用户在你面前的屏幕上做了 ' + annotations.length + ' 个标注并说了 ' + phrases.length + ' 段话。'
    : '[hyprscope desktop annotation] The user marked ' + annotations.length + ' places on your screen and spoke ' + phrases.length + ' times.')
  lines.push(chinese
    ? '截图是干净原图，标注与评论没有画在图上；位置以下面的几何为准（图像像素，左上原点）。'
    : 'The screenshot is clean: annotations and comments are not drawn on it. Use the geometry below (image pixels, top-left origin).')
  lines.push('')
  lines.push((chinese ? '屏幕：' : 'Monitor: ') + capture.monitor + ' '
    + capture.layoutRect[2] + 'x' + capture.layoutRect[3] + ' @' + scale
    + (chinese ? '（截图 ' : ' (image ') + capture.width + 'x' + capture.height
    + (chinese ? '，图像坐标 = 屏幕坐标 × ' : ', image coordinate = screen coordinate x ') + scale + ')')
  const cursor = session.context && Array.isArray(session.context.cursor) ? session.context.cursor : null
  const focused = session.context ? session.context.focusedWindow : null
  lines.push((chinese ? '鼠标：全局 ' : 'Pointer: global ') + (cursor === null ? '?' : '(' + cursor[0] + ',' + cursor[1] + ')')
    + (chinese ? '   焦点窗口：' : '   focused: ') + (focused === null ? '?' : focused))
  lines.push('')
  lines.push(chinese ? '可见窗口（z 序，后者在上）：' : 'Visible windows (z order, later on top):')
  const windows = session.context && Array.isArray(session.context.windows) ? session.context.windows : []
  for (const window of windows) {
    lines.push('- ' + window.id + ' ' + window.class + ' "' + window.title + '" rect('
      + window.rect.join(',') + ') ws' + window.workspace + ' mon' + window.monitor
      + (window.focused ? ' focused' : ''))
  }
  if (windows.length === 0) lines.push(chinese ? '- （无）' : '- (none)')
  lines.push('')
  lines.push(chinese ? '标注：' : 'Annotations:')
  const linksOf = (annotationId) => links.filter(link => link.annotationIds.includes(annotationId))
  for (const annotation of annotations) {
    const screenRect = [
      Math.round(annotation.from[0] / scale), Math.round(annotation.from[1] / scale),
      Math.round(annotation.to[0] / scale), Math.round(annotation.to[1] / scale),
    ]
    lines.push('#' + annotation.index + ' t=' + relativeLabel(annotation.atStart, session.startedAt)
      + '-' + relativeLabel(annotation.atEnd, session.startedAt) + ' ' + annotation.shape
      + ' image(' + annotation.from.join(',') + ')-(' + annotation.to.join(',') + ')'
      + (chinese ? ' ≈ 屏幕(' : ' ~ screen(') + screenRect[0] + ',' + screenRect[1] + ')-(' + screenRect[2] + ',' + screenRect[3] + ')'
      + (annotation.windowId ? (chinese ? ' 命中窗口 ' : ' hit window ') + annotation.windowId : ''))
    if (typeof annotation.comment === 'string' && annotation.comment.trim() !== '') {
      lines.push((chinese ? '   评论：' : '   comment: ') + annotation.comment.trim().slice(0, 2_000))
    }
    for (const link of linksOf(annotation.id)) {
      const phrase = phrases.find(item => item.id === link.voiceIds[0])
      if (phrase === undefined) continue
      const overlap = Math.max(0, Math.min(annotation.atEnd, phrase.atEnd) - Math.max(annotation.atStart, phrase.atStart))
      lines.push((chinese ? '   语音 ' : '   speech ') + phrase.id + ' t=' + relativeLabel(phrase.atStart, session.startedAt)
        + '-' + relativeLabel(phrase.atEnd, session.startedAt) + '：' + JSON.stringify(phrase.text)
        + '（' + (chinese ? '重叠 ' : 'overlap ') + Math.round(overlap) + 'ms'
        + (chinese ? '，置信度 ' : ', confidence ') + link.confidence
        + (link.ambiguous ? (chinese ? '，有歧义' : ', ambiguous') : '') + '）')
    }
  }
  if (annotations.length === 0) lines.push(chinese ? '#（无）' : '# (none)')
  lines.push('')
  lines.push(chinese ? '语音（按时间）：' : 'Speech (by time):')
  for (const phrase of phrases) {
    const bound = links.filter(link => link.voiceIds.includes(phrase.id)).flatMap(link => link.annotationIds)
    lines.push('- ' + phrase.id + ' t=' + relativeLabel(phrase.atStart, session.startedAt)
      + '-' + relativeLabel(phrase.atEnd, session.startedAt) + '：' + JSON.stringify(phrase.text)
      + (bound.length > 0 ? (chinese ? '（→ 标注 ' : ' (-> annotations ') + bound.join(',') + ')' : (chinese ? '（未绑定，按全局备注理解）' : ' (unbound, treat as a global note)')))
  }
  if (phrases.length === 0) lines.push(chinese ? '- （无）' : '- (none)')
  const note = typeof overallNote === 'string' ? overallNote.trim().slice(0, 2_000) : ''
  if (note !== '') {
    lines.push('')
    lines.push((chinese ? '用户补充：' : 'User note: ') + note)
  }
  if (input.imageAttached === false) {
    lines.push('')
    lines.push(chinese ? '（截图超过大小上限，未附图；请只依据以上元数据理解。）' : '(The screenshot exceeded the size limit and is not attached; rely on the metadata above.)')
  }
  const text = lines.join('\n')
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
}

/**
 * Start the annotation bridge runner.
 *
 * The returned object is created synchronously and drives one annotate session
 * at a time. Every failure is contained in the session directory so the overlay
 * can show it; nothing here may throw into the plugin activation path.
 * @param {object} options Host context, settings, paths and Host adapters.
 * @returns {{ handleRequest: (request: object) => void, dispose: () => Promise<void> }} Runner handle.
 */
export function createAnnotateRunner(options) {
  const { ctx, settings, messagePaths: paths, runCli, warn, resolveTarget, prompt } = options
  const language = settings.messageLanguage === 'en' ? 'en' : 'zh'
  // Tests inject a recorder that writes synthetic PCM; production spawns parec
  // or arecord through the same tiny interface.
  const recorderStart = typeof options.recorderStart === 'function' ? options.recorderStart : startRecorder
  const state = { disposed: false, session: null, busy: false, lastNonce: null }

  const env = () => Object.assign({}, process.env, { HYPRSCOPE_MESSAGE_DIR: paths.dir })

  const speech = () => {
    try {
      const service = ctx.get('speechToText')
      return service !== undefined && service !== null && typeof service.resolve === 'function'
        && typeof service.transcribe === 'function' ? service : null
    } catch {
      return null
    }
  }

  const writeJson = async (path, value) => {
    const temporary = path + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex')
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  const writeError = async (session, message) => {
    try {
      await writeJson(join(session.dir, 'error.json'), { version: 1, message, at: Date.now() })
      session.state = 'error'
    } catch {
      // The session directory may be gone; the log still carries the reason.
    }
  }

  /**
   * Run one read-only CLI command inside the message environment.
   * @param {string[]} argv CLI arguments after the binary.
   * @returns {Promise<object>} Parsed JSON stdout.
   */
  const observe = async (argv) => {
    const result = await runCli(argv, { timeoutMs: settings.timeoutMs + 5_000, env: env() })
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'exit ' + result.code)
    return JSON.parse(result.stdout)
  }

  async function startRecorder(dir) {
    const path = join(dir, 'audio.pcm')
    const handle = await open(path, 'w', 0o600)
    const candidates = [
      ['parec', ['--format=s16le', '--rate=16000', '--channels=1', '--file-format=raw', '--latency-msec=50']],
      ['arecord', ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw']],
    ]
    for (const [command, args] of candidates) {
      const startedAt = Date.now()
      const child = spawn(command, args, { stdio: ['ignore', handle.fd, 'ignore'] })
      const started = await new Promise((resolve) => {
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => finish(true), 150)
        child.once('error', () => finish(false))
        child.once('exit', () => finish(false))
      })
      if (started) {
        await handle.close().catch(() => {})
        const close = async () => {
          try {
            child.kill('SIGTERM')
            await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 1_000) })
          } catch {
            // Already gone.
          }
          await rm(path + '.lock', { force: true }).catch(() => {})
        }
        return { child, startedAt, close }
      }
      child.kill('SIGKILL')
    }
    await handle.close().catch(() => {})
    return null
  }

  const stopRecorder = async (session) => {
    if (session.recorder === null) return
    const recorder = session.recorder
    session.recorder = null
    await recorder.close().catch(() => {})
  }

  const transcribeOne = async (session, segment) => {
    const path = join(session.dir, 'voice', segment.id + '.json')
    const service = speech()
    const fail = async (message) => {
      await writeJson(path, { id: segment.id, text: '', seconds: 0, error: message, phrases: [] }).catch(() => {})
    }
    if (session.audioStartedAt === null) return fail('the microphone recorder is unavailable')
    if (service === null) return fail('speech-to-text is not available in this DSH profile')
    let pcm
    try {
      pcm = await readFile(join(session.dir, 'audio.pcm'))
    } catch (error) {
      return fail('cannot read the recording: ' + (error instanceof Error ? error.message : String(error)))
    }
    const from = Math.max(0, segment.atStart)
    const to = Math.min(segment.atEnd, segment.atStart + MAX_SEGMENT_MS)
    let pieces = []
    try {
      pieces = splitPhrases(pcm, { audioStartedAt: session.audioStartedAt })
    } catch (error) {
      return fail('cannot segment the recording: ' + (error instanceof Error ? error.message : String(error)))
    }
    const inside = pieces.filter(piece => piece.atEnd > from && piece.atStart < to)
    const phrases = []
    for (const piece of inside) {
      const wav = encodeWav(slicePcm(pcm, piece.atStart, piece.atEnd, session.audioStartedAt))
      try {
        const spec = service.resolve({ audio: wav, language: session.language })
        const transcript = await service.transcribe(spec, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS))
        const text = isRecord(transcript) && typeof transcript.text === 'string' ? transcript.text.trim() : ''
        phrases.push({ atStart: piece.atStart, atEnd: piece.atEnd, text })
      } catch (error) {
        return fail('transcription failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    const text = phrases.map(phrase => phrase.text).join('').trim()
    const seconds = Math.round((to - from) / 100) / 10
    await writeJson(path, { id: segment.id, text, seconds, error: null, phrases })
  }

  const enqueue = (session, segment) => {
    session.queue = session.queue.then(() => transcribeOne(session, segment)).catch((error) => {
      warn('annotate: cannot transcribe segment ' + segment.id + ': ' + (error instanceof Error ? error.message : String(error)))
    })
    return session.queue
  }

  const readJsonFile = async (path) => {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  const pollVoice = async (session) => {
    const document = await readJsonFile(join(session.dir, 'voice-events.json'))
    if (!isRecord(document) || !Array.isArray(document.segments)) return
    for (const segment of document.segments) {
      if (!isRecord(segment) || typeof segment.id !== 'string') continue
      if (typeof segment.atEnd !== 'number' || segment.atEnd <= segment.atStart) continue
      if (session.voices.has(segment.id)) continue
      session.voices.add(segment.id)
      enqueue(session, { id: segment.id, atStart: segment.atStart, atEnd: segment.atEnd })
    }
  }

  const finish = async (session, outcome) => {
    if (session.finished) return
    session.finished = true
    if (session.timer !== null) clearInterval(session.timer)
    session.timer = null
    await stopRecorder(session)
    try {
      const record = JSON.parse(await readFile(join(session.dir, 'session.json'), 'utf8'))
      record.state = outcome
      await writeJson(join(session.dir, 'session.json'), record)
    } catch {
      // The session record may be gone; cleanup still proceeds.
    }
    await unlink(join(paths.dir, 'annotate', 'active.json')).catch(() => {})
    if (state.session === session) state.session = null
  }

  const cancel = async (session) => {
    await finish(session, 'cancelled')
  }

  const buildPhrases = async (session, send) => {
    const overrides = new Map()
    if (isRecord(send) && Array.isArray(send.segments)) {
      for (const segment of send.segments) {
        if (isRecord(segment) && typeof segment.id === 'string' && typeof segment.text === 'string') {
          overrides.set(segment.id, segment.text)
        }
      }
    }
    const anchors = new Map()
    const events = await readJsonFile(join(session.dir, 'voice-events.json'))
    if (isRecord(events) && Array.isArray(events.segments)) {
      for (const segment of events.segments) {
        if (!isRecord(segment) || typeof segment.id !== 'string') continue
        const anchor = isRecord(segment.anchor) ? segment.anchor : null
        if (anchor !== null && typeof anchor.annotationId === 'string') anchors.set(segment.id, anchor.annotationId)
      }
    }
    const phrases = []
    let files = []
    try {
      files = (await readdir(join(session.dir, 'voice'))).filter(name => name.endsWith('.json')).sort()
    } catch {
      files = []
    }
    for (const name of files) {
      const result = await readJsonFile(join(session.dir, 'voice', name))
      if (!isRecord(result) || typeof result.id !== 'string') continue
      const edited = overrides.get(result.id)
      const pieces = Array.isArray(result.phrases) ? result.phrases : []
      if (pieces.length === 0) {
        if (edited !== undefined && edited.trim() !== '') {
          phrases.push({ id: result.id, annotationId: null, atStart: 0, atEnd: 0, text: edited.trim(), anchor: null })
        }
        continue
      }
      for (let index = 0; index < pieces.length; index += 1) {
        const piece = pieces[index]
        if (!isRecord(piece) || typeof piece.text !== 'string' || piece.text.trim() === '') continue
        const text = edited !== undefined && pieces.length === 1 ? edited : piece.text
        const anchorId = anchors.get(result.id) ?? null
        phrases.push({
          id: result.id + '.' + (index + 1),
          segmentId: result.id,
          annotationId: anchorId,
          atStart: typeof piece.atStart === 'number' ? piece.atStart : 0,
          atEnd: typeof piece.atEnd === 'number' ? piece.atEnd : 0,
          text,
          anchor: anchorId === null ? null : { annotationId: anchorId },
        })
      }
    }
    return phrases
  }

  const readAnnotations = (send) => {
    if (!isRecord(send) || !Array.isArray(send.items)) return []
    return send.items.filter(isRecord).map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : 'a' + (index + 1),
      index: typeof item.index === 'number' ? item.index : index + 1,
      shape: item.shape === 'ellipse' || item.shape === 'arrow' ? item.shape : 'rect',
      from: Array.isArray(item.from) ? item.from : [0, 0],
      to: Array.isArray(item.to) ? item.to : [0, 0],
      atStart: typeof item.atStart === 'number' ? item.atStart : 0,
      atEnd: typeof item.atEnd === 'number' ? item.atEnd : 0,
      comment: typeof item.comment === 'string' ? item.comment : '',
      windowId: typeof item.windowId === 'string' ? item.windowId : null,
    }))
  }

  const send = async (session, document) => {
    if (!isRecord(document) || document.sessionId !== session.id) return
    if (session.sending || session.finished) return
    const key = typeof document.at === 'number' ? document.at : 0
    if (session.lastSendAt === key) return
    session.lastSendAt = key
    session.sending = true
    try {
      await stopRecorder(session)
      await pollVoice(session)
      session.queue = session.queue.then(() => undefined)
      await Promise.race([
        session.queue,
        new Promise(resolve => { setTimeout(resolve, QUEUE_SETTLE_MS) }),
      ])
      const annotations = readAnnotations(document)
      const phrases = await buildPhrases(session, document)
      let links = linkVoiceToAnnotations(annotations, phrases, {})
      // Review-card re-binding is authoritative: an explicit annotationId (or
      // null for "global note") replaces whatever the overlap rule decided.
      const manual = new Map()
      if (Array.isArray(document.segments)) {
        for (const segment of document.segments) {
          if (isRecord(segment) && typeof segment.id === 'string' && 'annotationId' in segment) {
            manual.set(segment.id, typeof segment.annotationId === 'string' ? segment.annotationId : null)
          }
        }
      }
      if (manual.size > 0) {
        const belongsTo = (voiceId) => [...manual.keys()].some(id => voiceId === id || voiceId.startsWith(id + '.'))
        links = links.filter(link => !link.voiceIds.some(belongsTo))
        for (const [segmentId, annotationId] of manual) {
          if (annotationId === null) continue
          for (const phrase of phrases.filter(item => item.segmentId === segmentId)) {
            links.push({ annotationIds: [annotationId], voiceIds: [phrase.id], confidence: 1, source: 'manual', ambiguous: false })
          }
        }
      }
      const text = composeIntentCard({
        session, annotations, phrases, links, language,
        overallNote: typeof document.overallNote === 'string' ? document.overallNote : '',
        imageAttached: true,
      })
      let image = null
      try {
        const bytes = await readFile(session.capture.path)
        if (bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) {
          image = { mediaType: 'image/png', data: bytes.toString('base64'), name: 'annotate-' + session.id + '.png' }
        }
      } catch {
        image = null
      }
      const card = image === null
        ? composeIntentCard({ session, annotations, phrases, links, language, overallNote: document.overallNote, imageAttached: false })
        : text
      const parts = [{ type: 'text', text: card }]
      if (image !== null) parts.push(Object.assign({ type: 'image' }, image))
      let sessionId = null
      try {
        sessionId = await resolveTarget()
        await prompt(sessionId, parts, 'annotate-' + session.id)
        await writeJson(join(session.dir, 'ack.json'), {
          version: 1, ok: true, message: image === null ? 'sent without the screenshot' : null,
          sessionId, at: Date.now(),
        })
        await finish(session, 'sent')
      } catch (error) {
        await writeJson(join(session.dir, 'ack.json'), {
          version: 1, ok: false, message: error instanceof Error ? error.message : String(error),
          sessionId, at: Date.now(),
        }).catch(() => {})
        session.sending = false
        session.state = 'error'
      }
    } catch (error) {
      session.sending = false
      await writeError(session, error instanceof Error ? error.message : String(error))
      await writeJson(join(session.dir, 'ack.json'), {
        version: 1, ok: false, message: error instanceof Error ? error.message : String(error),
        sessionId: null, at: Date.now(),
      }).catch(() => {})
    }
  }

  const tick = async (session) => {
    if (state.disposed || session.finished || session.polling) return
    session.polling = true
    try {
      const sendDocument = await readJsonFile(join(session.dir, 'send.json'))
      if (sendDocument !== null) {
        await send(session, sendDocument)
        return
      }
      const cancelDocument = await readJsonFile(join(session.dir, 'cancel.json'))
      if (cancelDocument !== null) {
        await cancel(session)
        return
      }
      await pollVoice(session)
    } finally {
      session.polling = false
    }
  }

  const start = async (request) => {
    const startedAt = typeof request.at === 'string' && Number.isFinite(Date.parse(request.at))
      ? Date.parse(request.at) : Date.now()
    const id = sessionIdFor(new Date(startedAt))
    const dir = join(paths.dir, 'annotate', id)
    const session = {
      id, dir, startedAt, language,
      audioStartedAt: null,
      recorder: null,
      capture: null,
      context: null,
      state: 'preparing',
      timer: null,
      polling: false,
      sending: false,
      finished: false,
      queue: Promise.resolve(),
      voices: new Set(),
      lastSendAt: null,
    }
    state.session = session
    try {
      await mkdir(join(dir, 'voice'), { recursive: true, mode: 0o700 })
      // The CLI starts the overlay before writing the request. Give the overlay
      // one poll cycle to hide its hint and composer, otherwise the hint pill
      // ends up inside the frozen screenshot the user is about to annotate.
      await new Promise(resolve => { setTimeout(resolve, 300) })
      const recorder = await recorderStart(dir)
      session.recorder = recorder
      session.audioStartedAt = recorder === null ? null : recorder.startedAt
      const observation = await observe(['state', '--json'])
      const monitor = pickMonitor(observation)
      if (monitor === null) throw new Error('the compositor reported no monitors')
      const position = isRecord(monitor.position) ? monitor.position : { x: 0, y: 0 }
      const size = isRecord(monitor.size) ? monitor.size : { width: 0, height: 0 }
      const output = join(dir, 'capture.png')
      const shot = await observe(['screenshot', '--json', '--monitor', String(monitor.name), '--output', output])
      const focused = isRecord(observation.active) && isRecord(observation.active.window)
        && typeof observation.active.window.windowId === 'string' ? observation.active.window.windowId : null
      const windows = windowsFor(observation, [position.x, position.y, size.width, size.height], focused)
      const focusedWindow = windows.find(window => window.focused) ?? null
      session.capture = {
        path: typeof shot.path === 'string' ? shot.path : output,
        width: typeof shot.width === 'number' ? shot.width : 0,
        height: typeof shot.height === 'number' ? shot.height : 0,
        layoutRect: [position.x, position.y, size.width, size.height],
        monitor: String(monitor.name),
        scale: typeof monitor.scale === 'number' ? monitor.scale : 1,
        transform: typeof monitor.transform === 'number' ? monitor.transform : 0,
        sha256: typeof shot.sha256 === 'string' ? shot.sha256 : '',
      }
      session.context = {
        cursor: isRecord(observation.cursor) ? [observation.cursor.x, observation.cursor.y] : null,
        focusedWindow: focusedWindow === null ? focused : focusedWindow.id,
        windows,
        monitors: Array.isArray(observation.monitors) ? observation.monitors.map(monitorRecord => ({
          name: String(monitorRecord.name),
          rect: [
            isRecord(monitorRecord.position) ? monitorRecord.position.x : 0,
            isRecord(monitorRecord.position) ? monitorRecord.position.y : 0,
            isRecord(monitorRecord.size) ? monitorRecord.size.width : 0,
            isRecord(monitorRecord.size) ? monitorRecord.size.height : 0,
          ],
          scale: typeof monitorRecord.scale === 'number' ? monitorRecord.scale : 1,
          transform: typeof monitorRecord.transform === 'number' ? monitorRecord.transform : 0,
          focused: monitorRecord.focused === true,
          workspace: isRecord(monitorRecord.activeWorkspace) && typeof monitorRecord.activeWorkspace.id === 'number'
            ? monitorRecord.activeWorkspace.id : 0,
        })) : [],
      }
      session.state = 'ready'
      const record = {
        version: SESSION_VERSION, sessionId: id, mode: 'annotate', startedAt,
        audioStartedAt: session.audioStartedAt, state: session.state, language,
        capture: session.capture, context: session.context, error: null,
      }
      await writeJson(join(dir, 'session.json'), record)
      await writeJson(join(paths.dir, 'annotate', 'active.json'), {
        version: SESSION_VERSION, sessionId: id, dir, startedAt,
        audioStartedAt: session.audioStartedAt, state: 'ready',
      })
      session.timer = setInterval(() => { void tick(session) }, POLL_MS)
      if (session.timer !== null && typeof session.timer.unref === 'function') session.timer.unref()
    } catch (error) {
      await stopRecorder(session)
      await writeError(session, error instanceof Error ? error.message : String(error))
      state.session = null
      throw error
    }
  }

  return {
    handleRequest(request) {
      if (state.disposed || !isRecord(request) || request.mode !== 'annotate') return
      const at = typeof request.at === 'string' ? Date.parse(request.at) : Number.NaN
      if (!Number.isFinite(at) || Date.now() - at > REQUEST_FRESH_MS) return
      const nonce = typeof request.nonce === 'string' ? request.nonce : null
      if (nonce === null || nonce === state.lastNonce) return
      state.lastNonce = nonce
      if (state.busy || state.session !== null) {
        warn('annotate: request ignored because another session is open')
        return
      }
      state.busy = true
      void start(request).catch((error) => {
        warn('annotate: session failed: ' + (error instanceof Error ? error.message : String(error)))
      }).finally(() => {
        state.busy = false
      })
    },
    async dispose() {
      if (state.disposed) return
      state.disposed = true
      const session = state.session
      if (session !== null) await finish(session, 'cancelled').catch(() => {})
      state.session = null
    },
  }
}
