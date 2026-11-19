/**
 * Unit tests for the voice geometry module: WAV framing, PCM slicing, the
 * energy VAD and the voice-to-annotation pairing.
 *
 * The module is pure, so every signal is synthesized in memory and no
 * microphone, transcriber or DSH Host is involved.
 *
 * Run with: node --test plugins/dsh-hyprscope/test/voice.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { encodeWav, linkVoiceToAnnotations, pcmOffsetMs, slicePcm, splitPhrases } from '../voice.js'

/** Absolute epoch milliseconds of sample zero in every fixture. */
const T0 = 1_700_000_000_000

/** Sample rate of the session recording. */
const SAMPLE_RATE = 16000

/**
 * @param {number} ms Absolute epoch milliseconds relative to T0.
 * @returns {number} Absolute epoch milliseconds.
 */
function at(ms) {
  return T0 + ms
}

/**
 * Pack signed 16-bit samples little-endian, as the recording does.
 * @param {ArrayLike<number>} samples Sample values.
 * @returns {Buffer} PCM bytes.
 */
function samplesToBuffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], index * 2)
  }
  return buffer
}

/**
 * Synthesize a sine tone.
 * @param {number} ms Duration.
 * @param {number} [amplitude] Fraction of full scale.
 * @param {number} [hertz] Tone frequency.
 * @returns {Buffer} PCM bytes.
 */
function tone(ms, amplitude = 0.3, hertz = 440) {
  const count = Math.round(SAMPLE_RATE * ms / 1000)
  const samples = new Int16Array(count)
  for (let index = 0; index < count; index += 1) {
    const value = Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * hertz * index / SAMPLE_RATE))
    samples[index] = Math.max(-32768, Math.min(32767, value))
  }
  return samplesToBuffer(samples)
}

/**
 * Synthesize digital silence.
 * @param {number} ms Duration.
 * @returns {Buffer} PCM bytes.
 */
function silence(ms) {
  return Buffer.alloc(Math.round(SAMPLE_RATE * ms / 1000) * 2)
}

test('encodeWav writes the canonical 44-byte RIFF/WAVE header', () => {
  const pcm = Buffer.alloc(3200)
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = (index * 7) % 251

  const wav = encodeWav(pcm)
  assert.equal(wav.length, 44 + pcm.length)

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(view.getUint32(4, true), 36 + pcm.length)
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ')
  assert.equal(view.getUint32(16, true), 16)
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), SAMPLE_RATE)
  assert.equal(view.getUint32(28, true), SAMPLE_RATE * 2)
  assert.equal(view.getUint16(32, true), 2)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(wav.toString('ascii', 36, 40), 'data')
  assert.equal(view.getUint32(40, true), pcm.length)
  assert.deepEqual(wav.subarray(44), pcm)
})

test('encodeWav derives byteRate and blockAlign from the requested format', () => {
  const wav = encodeWav(Buffer.alloc(8), { sampleRate: 48000, channels: 2 })
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint16(22, true), 2)
  assert.equal(view.getUint32(24, true), 48000)
  assert.equal(view.getUint32(28, true), 48000 * 2 * 2)
  assert.equal(view.getUint16(32, true), 4)
  assert.equal(view.getUint32(40, true), 8)
  assert.equal(view.getUint32(4, true), 44)
})

test('encodeWav accepts an empty recording', () => {
  const wav = encodeWav(Buffer.alloc(0))
  assert.equal(wav.length, 44)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint32(4, true), 36)
  assert.equal(view.getUint32(40, true), 0)
})

test('encodeWav rejects an odd PCM length', () => {
  assert.throws(() => encodeWav(Buffer.alloc(3)), /even/)
  assert.throws(() => encodeWav(Buffer.alloc(4).subarray(0, 3)), /even/)
})

test('pcmOffsetMs converts absolute time and clamps to the recording', () => {
  assert.equal(pcmOffsetMs(at(250), at(0)), 250)
  assert.equal(pcmOffsetMs(at(-500), at(0)), 0)
  assert.equal(pcmOffsetMs(at(2000), at(0), 1000), 1000)
  assert.equal(pcmOffsetMs(at(200), at(0), 1000), 200)
  assert.equal(pcmOffsetMs(Number.NaN, at(0)), 0)
})

test('slicePcm cuts an absolute interval on sample boundaries', () => {
  const samples = new Int16Array(SAMPLE_RATE)
  for (let index = 0; index < samples.length; index += 1) samples[index] = index % 1000
  const pcm = samplesToBuffer(samples)

  assert.deepEqual(slicePcm(pcm, at(100), at(200), at(0)), pcm.subarray(3200, 6400))
  assert.equal(slicePcm(pcm, at(100), at(200), at(0)).length, 3200)
})

test('slicePcm clamps both ends and returns an empty buffer for no audio', () => {
  const pcm = Buffer.alloc(SAMPLE_RATE * 2)

  assert.equal(slicePcm(pcm, at(-500), at(100), at(0)).length, 3200)
  assert.deepEqual(slicePcm(pcm, at(900), at(5000), at(0)), pcm.subarray(28800, pcm.length))
  assert.equal(slicePcm(pcm, at(500), at(400), at(0)).length, 0)
  assert.equal(slicePcm(pcm, at(-900), at(-500), at(0)).length, 0)
  assert.equal(slicePcm(Buffer.alloc(0), at(0), at(100), at(0)).length, 0)
})

test('splitPhrases cuts a sine-and-silence signal into its two phrases', () => {
  const pcm = Buffer.concat([
    silence(200),
    tone(600),
    silence(500),
    tone(400),
    silence(200),
  ])
  const phrases = splitPhrases(pcm, { audioStartedAt: T0 })
  assert.deepEqual(phrases, [
    { atStart: at(0), atEnd: at(1000), byteStart: 0, byteEnd: 32000 },
    { atStart: at(1100), atEnd: at(1900), byteStart: 35200, byteEnd: 60800 },
  ])
})

test('splitPhrases returns nothing for a fully silent recording', () => {
  assert.deepEqual(splitPhrases(silence(1000), { audioStartedAt: T0 }), [])
  assert.deepEqual(splitPhrases(Buffer.alloc(0), { audioStartedAt: T0 }), [])
})

test('splitPhrases drops a phrase shorter than 200 ms', () => {
  const pcm = Buffer.concat([silence(300), tone(80), silence(300)])
  assert.deepEqual(splitPhrases(pcm, { audioStartedAt: T0 }), [])
})

test('splitPhrases keeps a short internal pause inside one phrase', () => {
  const pcm = Buffer.concat([tone(100), silence(100), tone(100)])
  const phrases = splitPhrases(pcm, { audioStartedAt: T0 })
  assert.equal(phrases.length, 1)
  assert.equal(phrases[0].atStart, at(0))
  assert.equal(phrases[0].atEnd, at(300))
})

test('splitPhrases splits a shared silent gap instead of overlapping phrases', () => {
  const pcm = Buffer.concat([tone(400), silence(300), tone(400)])
  const phrases = splitPhrases(pcm, { audioStartedAt: T0 })
  assert.equal(phrases.length, 2)
  assert.equal(phrases[0].atEnd, phrases[1].atStart)
  assert.equal(phrases[0].byteEnd, phrases[1].byteStart)
})

test('splitPhrases handles three minutes of audio in one linear pass', () => {
  const blocks = []
  for (let index = 0; index < 10; index += 1) {
    blocks.push(silence(1000), tone(10000), silence(7000))
  }
  const pcm = Buffer.concat(blocks)
  assert.equal(pcm.length, 180 * SAMPLE_RATE * 2)

  const started = Date.now()
  const phrases = splitPhrases(pcm, { audioStartedAt: T0 })
  const elapsed = Date.now() - started

  assert.equal(phrases.length, 10)
  assert.deepEqual(phrases[0], {
    atStart: at(800),
    atEnd: at(11200),
    byteStart: 25600,
    byteEnd: 358400,
  })
  assert.equal(phrases[9].atStart, at(9 * 18000 + 800))
  assert.ok(elapsed < 5000, 'three minutes took ' + elapsed + ' ms')
})

test('linkVoiceToAnnotations returns nothing without annotations or voices', () => {
  const annotations = [{ id: 'a1', atStart: at(1000), atEnd: at(3000) }]
  const segments = [{ id: 'v1', atStart: at(1200), atEnd: at(1800) }]
  assert.deepEqual(linkVoiceToAnnotations([], segments), [])
  assert.deepEqual(linkVoiceToAnnotations(annotations, []), [])
  assert.deepEqual(linkVoiceToAnnotations(undefined, segments), [])
  assert.deepEqual(linkVoiceToAnnotations(annotations, null), [])
  assert.deepEqual(linkVoiceToAnnotations(null, null), [])
})

test('rule 1: a unique strong overlap binds at 0.9', () => {
  const annotations = [
    { id: 'a1', atStart: at(1000), atEnd: at(3000), comment: '这个按钮右边多出来了' },
    { id: 'a2', atStart: at(9000), atEnd: at(10000) },
  ]
  const segments = [{ id: 'v1', atStart: at(1200), atEnd: at(1800) }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [
    { annotationIds: ['a1'], voiceIds: ['v1'], confidence: 0.9, source: 'overlap', ambiguous: false },
  ])
})

test('rule 2: several overlapping annotations bind the largest overlap at 0.6', () => {
  const annotations = [
    { id: 'a1', atStart: at(900), atEnd: at(1500) },
    { id: 'a2', atStart: at(1400), atEnd: at(2600) },
  ]
  const segments = [{ id: 'v1', atStart: at(1000), atEnd: at(2000) }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [
    { annotationIds: ['a2'], voiceIds: ['v1'], confidence: 0.6, source: 'overlap', ambiguous: true },
  ])
})

test('rule 2: a second overlapping annotation makes the strongest match ambiguous', () => {
  const annotations = [
    { id: 'a1', atStart: at(1000), atEnd: at(3000) },
    { id: 'a2', atStart: at(1700), atEnd: at(2600) },
  ]
  const segments = [{ id: 'v1', atStart: at(1200), atEnd: at(1800) }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [
    { annotationIds: ['a1'], voiceIds: ['v1'], confidence: 0.6, source: 'overlap', ambiguous: true },
  ])
})

test('rule 3: an anchor annotation binds at 0.8', () => {
  const annotations = [{ id: 'a1', atStart: at(2000), atEnd: at(3000) }]
  const segments = [{
    id: 'v1',
    atStart: at(5000),
    atEnd: at(5600),
    anchor: { x: 540, y: 240, annotationId: 'a1' },
  }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [
    { annotationIds: ['a1'], voiceIds: ['v1'], confidence: 0.8, source: 'anchor', ambiguous: false },
  ])
})

test('a partial overlap below 60% falls through to the anchor', () => {
  const annotations = [{ id: 'a1', atStart: at(2000), atEnd: at(3000) }]
  const segments = [{
    id: 'v1',
    atStart: at(2800),
    atEnd: at(3400),
    anchor: { annotationId: 'a1' },
  }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [
    { annotationIds: ['a1'], voiceIds: ['v1'], confidence: 0.8, source: 'anchor', ambiguous: false },
  ])

  const noAnchor = [{ id: 'v1', atStart: at(2800), atEnd: at(3400) }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, noAnchor), [])
})

test('rule 3: the nearest annotation starting within 2 s binds at 0.5', () => {
  const annotations = [
    { id: 'a1', atStart: at(5700), atEnd: at(6300) },
    { id: 'a2', atStart: at(5800), atEnd: at(6400) },
    { id: 'a3', atStart: at(9000), atEnd: at(9600) },
  ]
  const segments = [{ id: 'v1', atStart: at(5000), atEnd: at(5600) }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [
    { annotationIds: ['a1'], voiceIds: ['v1'], confidence: 0.5, source: 'sequence', ambiguous: false },
  ])
})

test('rule 3: a sequence outside the 2 s window stays a global note', () => {
  const annotations = [{ id: 'a1', atStart: at(9000), atEnd: at(9600) }]
  const segments = [{ id: 'v1', atStart: at(5000), atEnd: at(5600) }]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [])
})

test('rule 4: several voices keep their links to one annotation in time order', () => {
  const annotations = [{ id: 'a1', atStart: at(1000), atEnd: at(5000) }]
  const segments = [
    { id: 'v2', atStart: at(3000), atEnd: at(3600) },
    { id: 'v1', atStart: at(1200), atEnd: at(1800) },
  ]
  assert.deepEqual(linkVoiceToAnnotations(annotations, segments), [
    { annotationIds: ['a1'], voiceIds: ['v1'], confidence: 0.9, source: 'overlap', ambiguous: false },
    { annotationIds: ['a1'], voiceIds: ['v2'], confidence: 0.9, source: 'overlap', ambiguous: false },
  ])
})

test('rule 5: a text comment survives alongside the voice link', () => {
  const annotations = [
    { id: 'a1', atStart: at(1000), atEnd: at(3000), comment: '这个按钮右边多出来了' },
    { id: 'a2', atStart: at(5000), atEnd: at(6000), comment: '第二个问题' },
  ]
  const before = structuredClone(annotations)
  const segments = [{ id: 'v1', atStart: at(1200), atEnd: at(1800) }]

  const links = linkVoiceToAnnotations(annotations, segments)
  assert.equal(links.length, 1)
  assert.equal(links[0].annotationIds[0], 'a1')
  assert.deepEqual(annotations, before)
  assert.equal(annotations[0].comment, '这个按钮右边多出来了')
  assert.equal(annotations[1].comment, '第二个问题')
})

test('linkVoiceToAnnotations compares the absolute intervals it is given', () => {
  const annotations = [{ id: 'a1', atStart: at(1000), atEnd: at(3000) }]
  const segments = [{ id: 'v1', atStart: at(1200), atEnd: at(1800) }]
  assert.deepEqual(
    linkVoiceToAnnotations(annotations, segments, { audioStartedAt: at(0) }),
    linkVoiceToAnnotations(annotations, segments),
  )
})
