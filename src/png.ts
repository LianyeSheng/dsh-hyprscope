/**
 * Minimal PNG encoding for captures the compositor hands back as raw pixels.
 *
 * The native capture helper writes tightly packed RGBA rows and leaves framing
 * to this module, so the helper needs no image library and the repository gains
 * no build dependency beyond wayland-client.
 */
import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** One raw RGBA image. */
export interface RgbaImage {
  width: number
  height: number
  /** Tightly packed RGBA rows, 4 bytes per pixel. */
  rgba: Uint8Array
}

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()

/**
 * Compute one PNG chunk CRC.
 * @param type Four-character chunk type.
 * @param data Chunk payload.
 * @returns CRC-32 of type and payload.
 */
function crc32(type: string, data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of Buffer.from(type, 'latin1')) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build one PNG chunk.
 * @param type Chunk type.
 * @param data Chunk payload.
 * @returns Length, type, payload, and CRC.
 */
function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(type, data), 0)
  return Buffer.concat([header, data, crc])
}

/**
 * Encode a raw RGBA image as an 8-bit truecolour-with-alpha PNG.
 * @param image Dimensions and pixel data.
 * @returns PNG bytes.
 */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, rgba } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('encodePng needs positive integer dimensions')
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng got ${rgba.length} bytes for ${width}x${height} RGBA`)
  }
  const stride = width * 4
  const filtered = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    filtered[rowStart] = 0
    filtered.set(rgba.subarray(y * stride, (y + 1) * stride), rowStart + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(6, 9)
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  header.writeUInt8(0, 12)
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
