/**
 * Voice geometry for an annotate session: WAV framing, PCM slicing, a small
 * energy VAD and the voice-to-annotation pairing the intent card is built from.
 *
 * Every function here is pure — no process, no filesystem, no clock and no DSH
 * import — so the same code runs in a Node test, in the Host plugin and behind
 * the overlay bridge. Times crossing this module are absolute epoch
 * milliseconds (contract section 0); PCM is 16 kHz / mono / signed 16-bit
 * little-endian, which is exactly 32 bytes per millisecond.
 */

/** Bytes one millisecond of 16 kHz mono s16le audio occupies. */
const BYTES_PER_MS = 32

/** Default sample rate of the session recording. */
const DEFAULT_SAMPLE_RATE = 16000

/** Bytes per s16le sample. */
const BYTES_PER_SAMPLE = 2

/** Frame length the VAD scores. */
const FRAME_MS = 20

/** A silent run at least this long ends a phrase. */
const SILENCE_MS = 300

/** A phrase with less voiced audio than this is dropped. */
const MIN_PHRASE_MS = 200

/** Audio kept before the first and after the last voiced frame. */
const PAD_MS = 200

/** Lowest frame RMS treated as voice, in int16 units (about -48.7 dBFS). */
const FLOOR_RMS = 120

/** Percentile of the frame-RMS distribution taken as the noise floor. */
const NOISE_PERCENTILE = 0.2

/** Factor above the noise floor treated as voice. */
const NOISE_MULTIPLIER = 3

/** A voice must overlap this share of the shorter interval to bind directly. */
const OVERLAP_RATIO = 0.6

/** A voice may pull in an annotation that starts this soon after it ends. */
const SEQUENCE_WINDOW_MS = 2000

/**
 * @param {unknown} value Candidate.
 * @returns {boolean} Whether the value is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * View any byte container as bytes without copying when possible.
 * @param {unknown} pcm PCM bytes.
 * @returns {Buffer} The same bytes.
 */
function asPcmBuffer(pcm) {
  if (Buffer.isBuffer(pcm)) return pcm
  if (pcm instanceof Uint8Array) return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  throw new TypeError('voice: pcm must be a Buffer or a Uint8Array')
}

/**
 * @param {unknown} value Candidate number.
 * @param {string} name Option name used in the error.
 * @returns {number} A finite positive number.
 */
function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError('voice: ' + name + ' must be a positive number')
  }
  return value
}

/**
 * Encode raw s16le PCM as a RIFF/WAVE file: a strict 44-byte canonical header
 * followed by the samples, so a transcriber or player never has to guess.
 * @param {Buffer | Uint8Array} pcm Signed 16-bit little-endian samples.
 * @param {{ sampleRate?: number, channels?: number }} [options] Audio format.
 * @returns {Buffer} Complete WAV file.
 */
export function encodeWav(pcm, options = {}) {
  const bytes = asPcmBuffer(pcm)
  const sampleRate = positiveNumber(options.sampleRate ?? DEFAULT_SAMPLE_RATE, 'sampleRate')
  const channels = positiveNumber(options.channels ?? 1, 'channels')
  if (!Number.isInteger(sampleRate) || !Number.isInteger(channels)) {
    throw new RangeError('voice: sampleRate and channels must be integers')
  }
  // A truncated sample would silently shift every following sample by one byte.
  if (bytes.length % BYTES_PER_SAMPLE !== 0) {
    throw new Error('voice: PCM byte length must be even for s16le, got ' + bytes.length)
  }
  const dataSize = bytes.length
  const riffSize = 36 + dataSize
  if (riffSize > 0xffffffff) throw new RangeError('voice: PCM is too large for a RIFF header')

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(riffSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, bytes])
}

/**
 * Convert an absolute time to a non-negative millisecond offset from the start
 * of the recording, clamped to the recording length when one is supplied.
 * @param {number} at Absolute epoch milliseconds.
 * @param {number} [audioStartedAt] Absolute epoch milliseconds of sample zero.
 * @param {number} [totalMs] Recording length used for the upper clamp.
 * @returns {number} Offset in milliseconds within [0, totalMs].
 */
export function pcmOffsetMs(at, audioStartedAt = 0, totalMs = Infinity) {
  const origin = Number.isFinite(audioStartedAt) ? audioStartedAt : 0
  const time = Number.isFinite(at) ? at : origin
  const limit = Number.isFinite(totalMs) ? Math.max(0, totalMs) : Infinity
  return Math.min(Math.max(0, time - origin), limit)
}

/**
 * Cut one absolute interval out of the recording, clamped to the bytes that
 * exist. A reversed, empty or fully out-of-range interval yields an empty
 * buffer rather than an error, so callers can slice optimistically.
 * @param {Buffer | Uint8Array} pcm Signed 16-bit little-endian samples.
 * @param {number} atStart Absolute epoch milliseconds of the interval start.
 * @param {number} atEnd Absolute epoch milliseconds of the interval end.
 * @param {number} [audioStartedAt] Absolute epoch milliseconds of sample zero.
 * @returns {Buffer} PCM bytes, sample aligned.
 */
export function slicePcm(pcm, atStart, atEnd, audioStartedAt = 0) {
  const bytes = asPcmBuffer(pcm)
  const totalMs = bytes.length / BYTES_PER_MS
  const startMs = pcmOffsetMs(atStart, audioStartedAt, totalMs)
  const endMs = pcmOffsetMs(atEnd, audioStartedAt, totalMs)
  // Slice on a sample boundary: an odd byte offset would swap the high and low
  // halves of every following sample.
  const byteStart = Math.min(bytes.length, Math.round(startMs * BYTES_PER_MS / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE)
  const byteEnd = Math.min(bytes.length, Math.round(endMs * BYTES_PER_MS / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE)
  if (byteEnd <= byteStart) return Buffer.alloc(0)
  return bytes.subarray(byteStart, byteEnd)
}

/**
 * Score each complete frame by RMS, ignoring a trailing partial frame.
 * @param {Buffer} bytes PCM bytes.
 * @param {number} frameCount Complete frames to score.
 * @param {number} frameSamples Samples per frame.
 * @returns {Float64Array} RMS per frame in int16 units.
 */
function frameEnergies(bytes, frameCount, frameSamples) {
  const energies = new Float64Array(frameCount)
  const frameBytes = frameSamples * BYTES_PER_SAMPLE
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = frame * frameBytes
    let sum = 0
    for (let index = 0; index < frameSamples; index += 1) {
      const offset = base + index * BYTES_PER_SAMPLE
      let sample = bytes[offset] | (bytes[offset + 1] << 8)
      if (sample >= 0x8000) sample -= 0x10000
      sum += sample * sample
    }
    energies[frame] = Math.sqrt(sum / frameSamples)
  }
  return energies
}

/**
 * Pick the RMS above which a frame counts as voice. An absolute floor keeps
 * digital silence silent; the noise percentile adapts to a noisy microphone;
 * the peak cap keeps continuously loud audio from being classified as silence.
 * @param {Float64Array} energies Frame RMS values.
 * @param {object} options VAD overrides.
 * @returns {number} Threshold in int16 units.
 */
function voiceThreshold(energies, options) {
  if (Number.isFinite(options.threshold)) return Math.max(0, options.threshold)
  const sorted = Float64Array.from(energies).sort()
  const last = sorted.length - 1
  const peak = sorted[last]
  if (peak <= FLOOR_RMS) return FLOOR_RMS
  const percentile = Math.min(last, Math.max(0, Math.floor(last * NOISE_PERCENTILE)))
  const multiplier = positiveNumber(options.noiseMultiplier ?? NOISE_MULTIPLIER, 'noiseMultiplier')
  const adaptive = Math.max(FLOOR_RMS, sorted[percentile] * multiplier)
  return Math.max(FLOOR_RMS, Math.min(adaptive, peak / 2))
}

/**
 * Find voiced phrases in 16 kHz mono s16le audio with a frame-energy VAD.
 *
 * Frames are 20 ms and scored by RMS; a silent run of 300 ms ends a phrase,
 * phrases with less than 200 ms of voiced audio are dropped, and each surviving
 * phrase is padded by 200 ms on both sides (neighbouring phrases split the gap
 * instead of overlapping). The scan is linear in the byte length, so three
 * minutes of audio costs one pass over the samples.
 * @param {Buffer | Uint8Array} pcm Signed 16-bit little-endian samples.
 * @param {object} [options] VAD and timeline options.
 * @param {number} [options.sampleRate] Sample rate, 16000 by default.
 * @param {number} [options.audioStartedAt] Absolute epoch milliseconds of sample zero.
 * @param {number} [options.frameMs] Frame length, 20 ms by default.
 * @param {number} [options.silenceMs] Silent run that ends a phrase, 300 ms by default.
 * @param {number} [options.minPhraseMs] Minimum voiced audio, 200 ms by default.
 * @param {number} [options.padMs] Padding on each side, 200 ms by default.
 * @param {number} [options.threshold] Fixed RMS threshold instead of the adaptive one.
 * @param {number} [options.noiseMultiplier] Factor above the noise floor, 3 by default.
 * @returns {Array<{atStart: number, atEnd: number, byteStart: number, byteEnd: number}>}
 *   Absolute phrase bounds and their byte offsets into `pcm`.
 */
export function splitPhrases(pcm, options = {}) {
  const bytes = asPcmBuffer(pcm)
  const sampleRate = positiveNumber(options.sampleRate ?? DEFAULT_SAMPLE_RATE, 'sampleRate')
  const frameMs = positiveNumber(options.frameMs ?? FRAME_MS, 'frameMs')
  const silenceMs = positiveNumber(options.silenceMs ?? SILENCE_MS, 'silenceMs')
  const minPhraseMs = positiveNumber(options.minPhraseMs ?? MIN_PHRASE_MS, 'minPhraseMs')
  const padMs = Number.isFinite(options.padMs) ? Math.max(0, options.padMs) : PAD_MS
  const origin = Number.isFinite(options.audioStartedAt) ? options.audioStartedAt : 0
  const frameSamples = Math.max(1, Math.round(sampleRate * frameMs / 1000))
  const frameBytes = frameSamples * BYTES_PER_SAMPLE
  const bytesPerMs = sampleRate * BYTES_PER_SAMPLE / 1000
  const frameCount = Math.floor(bytes.length / frameBytes)
  if (frameCount === 0) return []

  const energies = frameEnergies(bytes, frameCount, frameSamples)
  const threshold = voiceThreshold(energies, options)
  const silenceFrames = Math.max(1, Math.round(silenceMs / frameMs))
  const minVoicedFrames = Math.max(1, Math.round(minPhraseMs / frameMs))
  const padFrames = Math.max(0, Math.round(padMs / frameMs))

  // Group voiced frames: only a silence run long enough to count as a gap ends
  // a phrase, so pauses inside one sentence stay inside one phrase.
  const raw = []
  let firstVoiced = -1
  let lastVoiced = -1
  let voicedFrames = 0
  let silentRun = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (energies[frame] >= threshold) {
      if (firstVoiced === -1) firstVoiced = frame
      lastVoiced = frame
      voicedFrames += 1
      silentRun = 0
    } else if (firstVoiced !== -1) {
      silentRun += 1
      if (silentRun >= silenceFrames) {
        raw.push({ first: firstVoiced, last: lastVoiced, voicedFrames })
        firstVoiced = -1
        lastVoiced = -1
        voicedFrames = 0
        silentRun = 0
      }
    }
  }
  if (firstVoiced !== -1) raw.push({ first: firstVoiced, last: lastVoiced, voicedFrames })

  const kept = raw.filter(item => item.voicedFrames * frameMs >= minPhraseMs - 1e-9)
  if (kept.length === 0) return []

  const ranges = kept.map(item => ({
    start: Math.max(0, item.first - padFrames),
    end: Math.min(frameCount - 1, item.last + padFrames),
  }))
  // Padding must never make two phrases overlap; split the silent gap in half
  // when they are closer than twice the padding.
  for (let index = 1; index < kept.length; index += 1) {
    if (ranges[index - 1].end < ranges[index].start) continue
    const boundary = Math.floor((kept[index - 1].last + kept[index].first) / 2)
    ranges[index - 1].end = Math.min(ranges[index - 1].end, boundary)
    ranges[index].start = Math.max(ranges[index].start, boundary + 1)
  }

  const phrases = []
  for (const range of ranges) {
    if (range.start > range.end) continue
    const byteStart = range.start * frameBytes
    const byteEnd = Math.min(bytes.length, (range.end + 1) * frameBytes)
    phrases.push({
      atStart: Math.round(origin + byteStart / bytesPerMs),
      atEnd: Math.round(origin + byteEnd / bytesPerMs),
      byteStart,
      byteEnd,
    })
  }
  return phrases
}

/**
 * @param {unknown} item Annotation or voice record.
 * @returns {{ lo: number, hi: number } | null} Normalized absolute interval.
 */
function spanOf(item) {
  if (!isRecord(item)) return null
  if (!Number.isFinite(item.atStart) || !Number.isFinite(item.atEnd)) return null
  return { lo: Math.min(item.atStart, item.atEnd), hi: Math.max(item.atStart, item.atEnd) }
}

/**
 * @param {string} annotationId Bound annotation identity.
 * @param {string} voiceId Bound voice identity.
 * @param {number} confidence Pairing confidence.
 * @param {string} source Rule that produced the pairing.
 * @param {boolean} ambiguous Whether another annotation was a plausible match.
 * @returns {{annotationIds: string[], voiceIds: string[], confidence: number, source: string, ambiguous: boolean}}
 *   One link, as contract section 7 defines it.
 */
function makeLink(annotationId, voiceId, confidence, source, ambiguous) {
  return {
    annotationIds: [annotationId],
    voiceIds: [voiceId],
    confidence,
    source,
    ambiguous,
  }
}

/**
 * Pair one voice segment with at most one annotation, following contract
 * section 7:
 * 1. one overlapping annotation reaching 60% of the shorter interval binds at
 *    0.9 with source "overlap";
 * 2. several overlapping annotations bind the largest overlap at 0.6 and are
 *    flagged ambiguous;
 * 3. without a usable overlap, an anchor annotation id binds at 0.8 with
 *    source "anchor", then the nearest annotation starting within 2 s after the
 *    voice binds at 0.5 with source "sequence", otherwise nothing is bound.
 * A partial overlap below 60% is not a confident temporal match and falls
 * through to rule 3 rather than inventing a confidence.
 * @param {{lo: number, hi: number}} span Voice interval.
 * @param {object} voice Voice segment.
 * @param {Array<object>} timed Annotations with a valid interval.
 * @param {Map<string, object>} known Annotations by id, including untimed ones.
 * @returns {object | null} Internal binding record, or null when unbound.
 */
function bindVoice(span, voice, timed, known) {
  const overlaps = []
  for (const annotation of timed) {
    const overlap = Math.min(span.hi, annotation.span.hi) - Math.max(span.lo, annotation.span.lo)
    if (overlap <= 0) continue
    const shorter = Math.min(span.hi - span.lo, annotation.span.hi - annotation.span.lo)
    const ratio = shorter > 0 ? overlap / shorter : 0
    overlaps.push({ annotation, overlap, ratio })
  }
  if (overlaps.length > 0) {
    const qualified = overlaps.filter(item => item.ratio >= OVERLAP_RATIO - 1e-9)
    if (overlaps.length === 1 && qualified.length === 1) {
      return makeLink(overlaps[0].annotation.id, voice.id, 0.9, 'overlap', false)
    }
    // A single weak overlap is not a confident match: fall through to the
    // anchor and sequence rules instead of inventing a confidence.
    if (overlaps.length > 1) {
      // Largest overlap wins; ties prefer the larger share of the shorter
      // interval, then the earlier annotation, then annotation input order.
      const best = overlaps.slice().sort((left, right) =>
        right.overlap - left.overlap
        || right.ratio - left.ratio
        || left.annotation.span.lo - right.annotation.span.lo
        || left.annotation.order - right.annotation.order)[0]
      return makeLink(best.annotation.id, voice.id, 0.6, 'overlap', true)
    }
  }

  const anchor = isRecord(voice.anchor) ? voice.anchor : null
  const anchorId = anchor !== null && typeof anchor.annotationId === 'string' ? anchor.annotationId : null
  if (anchorId !== null && known.has(anchorId)) {
    return makeLink(anchorId, voice.id, 0.8, 'anchor', false)
  }

  let nearest = null
  for (const annotation of timed) {
    const delay = annotation.span.lo - span.hi
    if (delay < 0 || delay > SEQUENCE_WINDOW_MS) continue
    if (nearest === null || delay < nearest.delay
      || (delay === nearest.delay && annotation.order < nearest.annotation.order)) {
      nearest = { annotation, delay }
    }
  }
  if (nearest !== null) return makeLink(nearest.annotation.id, voice.id, 0.5, 'sequence', false)
  return null
}

/**
 * Link voice segments to the annotations they describe, using absolute
 * `atStart`/`atEnd` intervals on both sides (contract section 0). Text
 * comments are never read or changed, so rule 5 — both present in the card,
 * neither overwriting the other — follows from every annotation surviving.
 *
 * A voice that binds nothing is a global note and is left out of the result;
 * the caller still has the segment for the card's voice list. Several voices
 * may bind the same annotation (rule 4): every link is returned, ordered by
 * voice time.
 * @param {Array<object> | null | undefined} annotations Annotation documents.
 * @param {Array<object> | null | undefined} segments Voice events from voice-events.json.
 * @param {{ audioStartedAt?: number }} [options] Accepted for call-site symmetry;
 *   intervals are already absolute, so no conversion is applied.
 * @returns {Array<{annotationIds: string[], voiceIds: string[], confidence: number, source: string, ambiguous: boolean}>}
 *   One link per bound voice, in voice time order.
 */
export function linkVoiceToAnnotations(annotations, segments, options = {}) {
  const annotationList = Array.isArray(annotations) ? annotations : []
  const voiceList = Array.isArray(segments) ? segments : []
  if (annotationList.length === 0 || voiceList.length === 0) return []

  const known = new Map()
  const timed = []
  const timedIds = new Set()
  for (const item of annotationList) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue
    if (!known.has(item.id)) known.set(item.id, item)
    const span = spanOf(item)
    if (span === null || timedIds.has(item.id)) continue
    timedIds.add(item.id)
    timed.push({ id: item.id, span, order: timed.length })
  }

  const linked = []
  let voiceOrder = 0
  for (const voice of voiceList) {
    const span = spanOf(voice)
    if (span === null || typeof voice.id !== 'string' || voice.id === '') continue
    const binding = bindVoice(span, voice, timed, known)
    if (binding !== null) linked.push({ binding, voiceStart: span.lo, voiceOrder })
    voiceOrder += 1
  }
  // Rule 4 asks for time order; the sort is stable so equal starts keep input order.
  linked.sort((left, right) => left.voiceStart - right.voiceStart || left.voiceOrder - right.voiceOrder)
  return linked.map(item => item.binding)
}
