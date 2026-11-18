/** PNG encoding from raw RGBA rows. */
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { encodePng } from '../src/png.ts'

test('encodePng writes signature, IHDR, and deflated scanlines', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255])
  const png = encodePng({ width: 2, height: 2, rgba })
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 2)
  assert.equal(png.readUInt32BE(20), 2)
  assert.equal(png.readUInt8(24), 8)
  assert.equal(png.readUInt8(25), 6)
  const idatStart = png.indexOf(Buffer.from('IDAT', 'latin1')) - 4
  const idatLength = png.readUInt32BE(idatStart)
  const data = inflateSync(png.subarray(idatStart + 8, idatStart + 8 + idatLength))
  const expected = Buffer.concat([
    Buffer.from([0]), Buffer.from(rgba.subarray(0, 8)),
    Buffer.from([0]), Buffer.from(rgba.subarray(8)),
  ])
  assert.deepEqual(data, expected)
})

test('encodePng rejects mismatched dimensions', () => {
  assert.throws(() => encodePng({ width: 2, height: 1, rgba: new Uint8Array(4) }), /encodePng got 4 bytes/)
  assert.throws(() => encodePng({ width: 0, height: 1, rgba: new Uint8Array(0) }), /positive integer/)
})
