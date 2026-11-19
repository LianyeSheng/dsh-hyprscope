/** Annotate-session state files shared by the CLI, the overlay and the DSH plugin. */
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './state.ts'

/** Version every annotate document carries except `voice/<id>.json`, which has none. */
export const ANNOTATE_VERSION = 1

/** Annotation shapes the overlay can draw. */
export type AnnotationShape = 'rect' | 'ellipse' | 'arrow'

/** Point in capture.png image pixels (physical pixels). */
export type Point = [number, number]

/** Rectangle as `[x, y, width, height]`. */
export type Rect = [number, number, number, number]

/** One annotation the overlay wrote. */
export interface AnnotationItem {
  /** Overlay-assigned identifier, for example `a1`. */
  id: string
  /** One-based display number; reassigned whenever the list is reordered. */
  index: number
  /** Shape drawn by the user. */
  shape: AnnotationShape
  /** Image-pixel start point. */
  from: Point
  /** Image-pixel end point. */
  to: Point
  /** Epoch milliseconds when drawing started. */
  atStart: number
  /** Epoch milliseconds when the annotation was finished. */
  atEnd: number
  /** Text comment attached to the annotation; empty when none. */
  comment: string
  /** Hyprland window address the overlay hit-tested, when one matched. */
  windowId?: string
}

/** Pointer and selection captured when push-to-talk started. */
export interface VoiceAnchor {
  /** Global layout x coordinate of the pointer. */
  x: number
  /** Global layout y coordinate of the pointer. */
  y: number
  /** Hyprland window address under the pointer, when one matched. */
  windowId?: string
  /** Annotation selected or drawn at that moment, when one was. */
  annotationId?: string
}

/** One push-to-talk segment the overlay recorded. */
export interface VoiceSegment {
  /** Overlay-assigned identifier, for example `v1`. */
  id: string
  /** Epoch milliseconds when recording started. */
  atStart: number
  /** Epoch milliseconds when recording stopped. */
  atEnd: number
  /** Pointer/an annotation captured at recording start; omitted when none. */
  anchor?: VoiceAnchor
}

/** The screenshot one annotate session works on. */
export interface CaptureRecord {
  /** Absolute path of the clean screenshot. */
  path: string
  /** Image width in physical pixels. */
  width: number
  /** Image height in physical pixels. */
  height: number
  /** Monitor rectangle in Hyprland layout coordinates. */
  layoutRect: Rect
  /** Monitor name the capture came from. */
  monitor: string
  /** Monitor scale factor: image pixels = layout pixels × scale. */
  scale: number
  /** Monitor transform the capture used. */
  transform: number
  /** Hex digest of the capture file, so the plugin can verify it. */
  sha256: string
}

/** One visible window in the session context, in z order. */
export interface WindowRecord {
  /** Hyprland window address. */
  id: string
  /** Window class or application id. */
  class: string
  /** Window title. */
  title: string
  /** Owning process id. */
  pid: number
  /** Window rectangle in layout coordinates. */
  rect: Rect
  /** Workspace id the window sits on. */
  workspace: number
  /** Monitor the window is on. */
  monitor: string
  /** Whether the window has keyboard focus. */
  focused: boolean
  /** Whether the window floats. */
  floating: boolean
}

/** One monitor in the session context. */
export interface MonitorRecord {
  /** Monitor name, for example `DP-1`. */
  name: string
  /** Monitor rectangle in layout coordinates. */
  rect: Rect
  /** Monitor scale factor. */
  scale: number
  /** Monitor transform. */
  transform: number
  /** Whether the monitor has focus. */
  focused: boolean
  /** Active workspace on the monitor. */
  workspace: number
}

/** Desktop context the plugin captured with the screenshot. */
export interface SessionContext {
  /** Pointer position in layout coordinates, or null when it was unreachable. */
  cursor: Point | null
  /** Focused window address, or null when no window is focused. */
  focusedWindow: string | null
  /** Windows intersecting the capture, at most 24, in z order. */
  windows: WindowRecord[]
  /** Monitors known at trigger time. */
  monitors: MonitorRecord[]
}

/** `session.json`: written by the plugin, read by the overlay. */
export interface SessionFile {
  version: 1
  /** Session identifier, also the directory name below `annotate/`. */
  sessionId: string
  mode: 'annotate'
  /** Epoch milliseconds of the trigger; the base of every relative time. */
  startedAt: number
  /** Epoch milliseconds of the first PCM sample, or null when the recorder never started. */
  audioStartedAt: number | null
  /** Plugin session state, for example `ready`. */
  state: string
  /** Language the transcript and overlay should use. */
  language: 'zh' | 'en'
  capture: CaptureRecord
  context: SessionContext
  /** Plugin error text, or null while the session is healthy. */
  error: string | null
}

/** `annotate/active.json`: the plugin's entry point the overlay polls while loading. */
export interface ActiveFile {
  version: 1
  /** Session identifier the overlay then opens. */
  sessionId: string
  /** Absolute session directory. */
  dir: string
  /** Epoch milliseconds of the trigger. */
  startedAt: number
  /** Epoch milliseconds of the first PCM sample, or null when the recorder never started. */
  audioStartedAt: number | null
  /** Plugin session state, for example `ready`. */
  state: string
}

/** `annotations.json`: written by the overlay on every change. */
export interface AnnotationsFile {
  version: 1
  items: AnnotationItem[]
}

/** `voice-events.json`: written by the overlay when push-to-talk segments change. */
export interface VoiceEventsFile {
  version: 1
  segments: VoiceSegment[]
}

/** `voice/<id>.json`: one transcript written by the plugin. */
export interface VoiceResultFile {
  /** Segment identifier, matching `VoiceSegment.id`. */
  id: string
  /** Transcribed text; empty when the service failed. */
  text: string
  /** Segment duration in seconds. */
  seconds: number
  /** Transcription error text, or null on success. */
  error: string | null
  /** VAD phrases inside the push-to-talk segment; the card pairs at this granularity. */
  phrases?: Array<{ atStart: number; atEnd: number; text: string }>
}

/** One submitted voice segment, with the user's final text edits applied. */
export interface SendSegment {
  /** Segment identifier, matching `VoiceSegment.id`. */
  id: string
  /** Final transcript the plugin injects; it never re-reads `voice/<id>.json`. */
  text: string
  /** Manual re-binding chosen in review; null means "treat as a global note". */
  annotationId?: string | null
}

/** `send.json`: written by the overlay on submit. */
export interface SendFile {
  version: 1
  /** Annotate session the submission belongs to. */
  sessionId: string
  /** Epoch milliseconds of the submission. */
  at: number
  /** Free-form remark that applies to the whole message. */
  overallNote: string
  /** Annotations exactly as submitted. */
  items: AnnotationItem[]
  /** Final voice transcripts, in recording order. */
  segments: SendSegment[]
}

/** `ack.json`: the plugin's injection receipt. */
export interface AckFile {
  version: 1
  /** Whether the prompt was injected. */
  ok: boolean
  /** Failure text when `ok` is false. */
  message: string | null
  /** DSH session the prompt went to, or null when admission failed before a target existed. */
  sessionId: string | null
  /** Epoch milliseconds the receipt was written. */
  at: number
}

/** Every path one annotate session uses. */
export interface AnnotateSessionPaths {
  /** Per-session directory below `annotate/`. */
  dir: string
  /** Session record written by the plugin. */
  sessionFile: string
  /** Raw 16 kHz mono s16le PCM written by the plugin. */
  audioFile: string
  /** Push-to-talk segment list written by the overlay. */
  voiceEventsFile: string
  /** Directory of per-segment transcript files. */
  voiceDir: string
  /** Annotation geometry and comments written by the overlay. */
  annotationsFile: string
  /** Final submission written by the overlay. */
  sendFile: string
  /** Injection receipt written by the plugin. */
  ackFile: string
  /** User cancellation, written by the overlay when it happens. */
  cancelFile: string
  /** Fatal session error, written by the plugin when one happens. */
  errorFile: string
}

/**
 * @param messageDir Desktop-message directory.
 * @returns Root directory that holds every annotate session.
 */
export function annotateDirectory(messageDir: string): string {
  return join(messageDir, 'annotate')
}

/**
 * The plugin's discovery entry point sits at the annotate root, not inside a
 * session directory: the overlay reads it before it knows the session id.
 * @param messageDir Desktop-message directory.
 * @returns Path of `active.json`.
 */
export function annotateActiveFile(messageDir: string): string {
  return join(annotateDirectory(messageDir), 'active.json')
}

/**
 * @param messageDir Desktop-message directory.
 * @param sessionId Session identifier from {@link annotateSessionId}.
 * @returns Every path that session uses.
 */
export function annotateSessionPaths(messageDir: string, sessionId: string): AnnotateSessionPaths {
  const dir = join(annotateDirectory(messageDir), sessionId)
  return {
    dir,
    sessionFile: join(dir, 'session.json'),
    audioFile: join(dir, 'audio.pcm'),
    voiceEventsFile: join(dir, 'voice-events.json'),
    voiceDir: join(dir, 'voice'),
    annotationsFile: join(dir, 'annotations.json'),
    sendFile: join(dir, 'send.json'),
    ackFile: join(dir, 'ack.json'),
    cancelFile: join(dir, 'cancel.json'),
    errorFile: join(dir, 'error.json'),
  }
}

/**
 * @param paths Session paths.
 * @param id Voice segment identifier.
 * @returns Path of that segment's transcript file.
 */
export function annotateVoiceResultPath(paths: AnnotateSessionPaths, id: string): string {
  return join(paths.voiceDir, `${id}.json`)
}

/**
 * Format an epoch-millisecond instant as the compact UTC ISO string the
 * session identifier starts with, for example `20261119T162512345Z`.
 * @param at Epoch milliseconds.
 * @returns Compact ISO string without separators.
 */
export function compactIsoTimestamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:.]/g, '')
}

/**
 * Build one session identifier: the trigger instant plus four random hex digits.
 * @param startedAt Epoch milliseconds of the trigger.
 * @param random Random source in `[0, 1)`; injectable for tests.
 * @returns Session identifier such as `20261119T162512345Z-a1b2`.
 */
export function annotateSessionId(startedAt: number, random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0x1_0000).toString(16).padStart(4, '0')
  return `${compactIsoTimestamp(startedAt)}-${suffix}`
}

/**
 * @param value Candidate value.
 * @returns Whether it has the session-identifier shape.
 */
export function isAnnotateSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8}T\d{9}Z-[0-9a-f]{4}$/.test(value)
}

/**
 * Relative time the intent card shows: `t = at - startedAt`.
 * @param at Epoch milliseconds of the event.
 * @param startedAt Epoch milliseconds of the session trigger.
 * @returns Milliseconds since the trigger; negative only for clock skew.
 */
export function relativeTimeMs(at: number, startedAt: number): number {
  return at - startedAt
}

/** @param value Candidate value. @returns Whether it is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param value Candidate value. @returns Whether it is a finite number. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** @param value Candidate value. @returns Whether it is a string or null. */
function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** @param value Candidate value. @returns Whether it is a two-number point. */
function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 && value.every(isNumber)
}

/** @param value Candidate value. @returns Whether it is a four-number rectangle. */
function isRect(value: unknown): value is Rect {
  return Array.isArray(value) && value.length === 4 && value.every(isNumber)
}

/** @param value Candidate value. @returns Whether it is an optional string field. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** @param value Candidate value. @returns Whether it is an annotation item. */
function isAnnotationItem(value: unknown): value is AnnotationItem {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && isNumber(value.index)
    && (value.shape === 'rect' || value.shape === 'ellipse' || value.shape === 'arrow')
    && isPoint(value.from)
    && isPoint(value.to)
    && isNumber(value.atStart)
    && isNumber(value.atEnd)
    && typeof value.comment === 'string'
    && isOptionalString(value.windowId)
}

/** @param value Candidate value. @returns Whether it is a voice anchor. */
function isVoiceAnchor(value: unknown): value is VoiceAnchor {
  if (!isRecord(value)) return false
  return isNumber(value.x)
    && isNumber(value.y)
    && isOptionalString(value.windowId)
    && isOptionalString(value.annotationId)
}

/** @param value Candidate value. @returns Whether it is a voice segment. */
function isVoiceSegment(value: unknown): value is VoiceSegment {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && isNumber(value.atStart)
    && isNumber(value.atEnd)
    && (value.anchor === undefined || isVoiceAnchor(value.anchor))
}

/** @param value Candidate value. @returns Whether it is a capture record. */
function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!isRecord(value)) return false
  return typeof value.path === 'string'
    && isNumber(value.width)
    && isNumber(value.height)
    && isRect(value.layoutRect)
    && typeof value.monitor === 'string'
    && isNumber(value.scale)
    && isNumber(value.transform)
    && typeof value.sha256 === 'string'
}

/** @param value Candidate value. @returns Whether it is a window record. */
function isWindowRecord(value: unknown): value is WindowRecord {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.class === 'string'
    && typeof value.title === 'string'
    && isNumber(value.pid)
    && isRect(value.rect)
    && isNumber(value.workspace)
    && typeof value.monitor === 'string'
    && typeof value.focused === 'boolean'
    && typeof value.floating === 'boolean'
}

/** @param value Candidate value. @returns Whether it is a monitor record. */
function isMonitorRecord(value: unknown): value is MonitorRecord {
  if (!isRecord(value)) return false
  return typeof value.name === 'string'
    && isRect(value.rect)
    && isNumber(value.scale)
    && isNumber(value.transform)
    && typeof value.focused === 'boolean'
    && isNumber(value.workspace)
}

/** @param value Candidate value. @returns Whether it is a session context. */
function isSessionContext(value: unknown): value is SessionContext {
  if (!isRecord(value)) return false
  return (value.cursor === null || isPoint(value.cursor))
    && isStringOrNull(value.focusedWindow)
    && Array.isArray(value.windows) && value.windows.every(isWindowRecord)
    && Array.isArray(value.monitors) && value.monitors.every(isMonitorRecord)
}

/**
 * @param value Candidate value.
 * @returns Whether it is a valid `session.json` document.
 */
export function isSessionFile(value: unknown): value is SessionFile {
  if (!isRecord(value)) return false
  return value.version === ANNOTATE_VERSION
    && typeof value.sessionId === 'string'
    && value.mode === 'annotate'
    && isNumber(value.startedAt)
    && (value.audioStartedAt === null || isNumber(value.audioStartedAt))
    && typeof value.state === 'string'
    && (value.language === 'zh' || value.language === 'en')
    && isCaptureRecord(value.capture)
    && isSessionContext(value.context)
    && isStringOrNull(value.error)
}

/**
 * @param value Candidate value.
 * @returns Whether it is a valid `active.json` document.
 */
export function isActiveFile(value: unknown): value is ActiveFile {
  if (!isRecord(value)) return false
  return value.version === ANNOTATE_VERSION
    && typeof value.sessionId === 'string'
    && typeof value.dir === 'string'
    && isNumber(value.startedAt)
    && isNumber(value.audioStartedAt)
    && typeof value.state === 'string'
}

/**
 * @param value Candidate value.
 * @returns Whether it is a valid `annotations.json` document.
 */
export function isAnnotationsFile(value: unknown): value is AnnotationsFile {
  if (!isRecord(value)) return false
  return value.version === ANNOTATE_VERSION
    && Array.isArray(value.items) && value.items.every(isAnnotationItem)
}

/**
 * @param value Candidate value.
 * @returns Whether it is a valid `voice-events.json` document.
 */
export function isVoiceEventsFile(value: unknown): value is VoiceEventsFile {
  if (!isRecord(value)) return false
  return value.version === ANNOTATE_VERSION
    && Array.isArray(value.segments) && value.segments.every(isVoiceSegment)
}

/**
 * @param value Candidate value.
 * @returns Whether it is a valid `voice/<id>.json` document.
 */
export function isVoiceResultFile(value: unknown): value is VoiceResultFile {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.text === 'string'
    && isNumber(value.seconds)
    && isStringOrNull(value.error)
}

/** @param value Candidate value. @returns Whether it is a send segment. */
function isSendSegment(value: unknown): value is SendSegment {
  if (!isRecord(value)) return false
  if (value.annotationId !== undefined) {
    if (value.annotationId !== null && typeof value.annotationId !== 'string') return false
  }
  return typeof value.id === 'string' && typeof value.text === 'string'
}

/**
 * @param value Candidate value.
 * @returns Whether it is a valid `send.json` document.
 */
export function isSendFile(value: unknown): value is SendFile {
  if (!isRecord(value)) return false
  return value.version === ANNOTATE_VERSION
    && typeof value.sessionId === 'string'
    && isNumber(value.at)
    && typeof value.overallNote === 'string'
    && Array.isArray(value.items) && value.items.every(isAnnotationItem)
    && Array.isArray(value.segments) && value.segments.every(isSendSegment)
}

/**
 * @param value Candidate value.
 * @returns Whether it is a valid `ack.json` document.
 */
export function isAckFile(value: unknown): value is AckFile {
  if (!isRecord(value)) return false
  return value.version === ANNOTATE_VERSION
    && typeof value.ok === 'boolean'
    && isStringOrNull(value.message)
    && isStringOrNull(value.sessionId)
    && isNumber(value.at)
}

/**
 * Read and validate one JSON document.
 * @param path Source path.
 * @param guard Validator for the document type.
 * @returns The document, or null when it is absent or invalid.
 */
async function readChecked<T>(path: string, guard: (value: unknown) => value is T): Promise<T | null> {
  const value = await readJson(path)
  return guard(value) ? value : null
}

/**
 * @param paths Session paths.
 * @returns Valid session record, or null.
 */
export async function readSessionFile(paths: AnnotateSessionPaths): Promise<SessionFile | null> {
  return readChecked(paths.sessionFile, isSessionFile)
}

/**
 * @param paths Session paths; the directory must exist.
 * @param file Session record.
 */
export async function writeSessionFile(paths: AnnotateSessionPaths, file: SessionFile): Promise<void> {
  await writeJsonAtomic(paths.sessionFile, file)
}

/**
 * @param messageDir Desktop-message directory.
 * @returns Valid loading entry point, or null.
 */
export async function readActiveFile(messageDir: string): Promise<ActiveFile | null> {
  return readChecked(annotateActiveFile(messageDir), isActiveFile)
}

/**
 * @param messageDir Desktop-message directory; `annotate/` must exist.
 * @param file Loading entry point.
 */
export async function writeActiveFile(messageDir: string, file: ActiveFile): Promise<void> {
  await writeJsonAtomic(annotateActiveFile(messageDir), file)
}

/**
 * @param paths Session paths.
 * @returns Valid annotations, or null.
 */
export async function readAnnotationsFile(paths: AnnotateSessionPaths): Promise<AnnotationsFile | null> {
  return readChecked(paths.annotationsFile, isAnnotationsFile)
}

/**
 * @param paths Session paths; the directory must exist.
 * @param file Annotations to persist atomically.
 */
export async function writeAnnotationsFile(paths: AnnotateSessionPaths, file: AnnotationsFile): Promise<void> {
  await writeJsonAtomic(paths.annotationsFile, file)
}

/**
 * @param paths Session paths.
 * @returns Valid voice events, or null.
 */
export async function readVoiceEventsFile(paths: AnnotateSessionPaths): Promise<VoiceEventsFile | null> {
  return readChecked(paths.voiceEventsFile, isVoiceEventsFile)
}

/**
 * @param paths Session paths; the directory must exist.
 * @param file Voice events to persist atomically.
 */
export async function writeVoiceEventsFile(paths: AnnotateSessionPaths, file: VoiceEventsFile): Promise<void> {
  await writeJsonAtomic(paths.voiceEventsFile, file)
}

/**
 * @param paths Session paths.
 * @param id Voice segment identifier.
 * @returns Valid transcript, or null.
 */
export async function readVoiceResultFile(
  paths: AnnotateSessionPaths,
  id: string,
): Promise<VoiceResultFile | null> {
  return readChecked(annotateVoiceResultPath(paths, id), isVoiceResultFile)
}

/**
 * @param paths Session paths; `voice/` must exist.
 * @param file Transcript to persist atomically.
 */
export async function writeVoiceResultFile(
  paths: AnnotateSessionPaths,
  file: VoiceResultFile,
): Promise<void> {
  await writeJsonAtomic(annotateVoiceResultPath(paths, file.id), file)
}

/**
 * @param paths Session paths.
 * @returns Valid submission, or null.
 */
export async function readSendFile(paths: AnnotateSessionPaths): Promise<SendFile | null> {
  return readChecked(paths.sendFile, isSendFile)
}

/**
 * @param paths Session paths; the directory must exist.
 * @param file Submission to persist atomically.
 */
export async function writeSendFile(paths: AnnotateSessionPaths, file: SendFile): Promise<void> {
  await writeJsonAtomic(paths.sendFile, file)
}

/**
 * @param paths Session paths.
 * @returns Valid injection receipt, or null.
 */
export async function readAckFile(paths: AnnotateSessionPaths): Promise<AckFile | null> {
  return readChecked(paths.ackFile, isAckFile)
}

/**
 * @param paths Session paths; the directory must exist.
 * @param file Injection receipt to persist atomically.
 */
export async function writeAckFile(paths: AnnotateSessionPaths, file: AckFile): Promise<void> {
  await writeJsonAtomic(paths.ackFile, file)
}
