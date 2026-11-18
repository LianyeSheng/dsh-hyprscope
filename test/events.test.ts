/** Event line parsing and the queued event stream. */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { EventStream, eventFields, parseEventLine, waitForEvent } from '../src/events.ts'
import { removeDir, tempDir } from './support.ts'

test('parseEventLine splits the first event>>payload separator', () => {
  assert.deepEqual(parseEventLine('workspace>>2'), { event: 'workspace', data: '2', raw: 'workspace>>2' })
  assert.deepEqual(parseEventLine('activewindow>>zen,Title with >> and , commas'), {
    event: 'activewindow', data: 'zen,Title with >> and , commas', raw: 'activewindow>>zen,Title with >> and , commas',
  })
  assert.deepEqual(parseEventLine('openwindow>>0x1,2,zen,Hello\r'), {
    event: 'openwindow', data: '0x1,2,zen,Hello', raw: 'openwindow>>0x1,2,zen,Hello',
  })
})

test('parseEventLine rejects blank and separator-less lines', () => {
  assert.equal(parseEventLine(''), null)
  assert.equal(parseEventLine('   '), null)
  assert.equal(parseEventLine('no-separator'), null)
  assert.equal(parseEventLine('>>payload-only'), null)
})

test('eventFields keeps empty trailing fields', () => {
  assert.deepEqual(eventFields('zen,Title,'), ['zen', 'Title', ''])
})

/** One-shot event server fixture. */
interface SocketFixture {
  path: string
  server: Server
  dir: string
}

/**
 * Start a one-shot server whose client socket writes the supplied chunks.
 * @param chunks Payloads written in order.
 * @param options Delay between chunks and whether the server ends the connection.
 * @returns Fixture.
 */
async function socketFixture(chunks: string[], options: { delayMs?: number; end?: boolean } = {}): Promise<SocketFixture> {
  const delayMs = options.delayMs ?? 0
  const end = options.end ?? true
  const dir = tempDir()
  const path = join(dir, 'events.sock')
  const server = createServer(socket => {
    let index = 0
    const writeNext = () => {
      if (index >= chunks.length) {
        if (end) socket.end()
        return
      }
      socket.write(chunks[index]!)
      index += 1
      setTimeout(writeNext, delayMs)
    }
    writeNext()
  })
  await new Promise<void>(resolve => { server.listen(path, () => resolve()) })
  return { path, server, dir }
}

test('EventStream delivers events across split chunks in order', async (t) => {
  const fixture = await socketFixture(['workspace>>2\nactivewi', 'ndow>>zen,Hello\n'])
  t.after(() => { fixture.server.close(); removeDir(fixture.dir) })
  const stream = new EventStream({ eventSocket: fixture.path })
  t.after(() => stream.close())
  const first = await stream.next({ timeoutMs: 1000 })
  const second = await stream.next({ timeoutMs: 1000 })
  assert.equal(first?.event, 'workspace')
  assert.equal(first?.data, '2')
  assert.equal(second?.event, 'activewindow')
  assert.equal(second?.data, 'zen,Hello')
})

test('EventStream times out a silent socket with TIMEOUT', async (t) => {
  const fixture = await socketFixture([], { end: false })
  t.after(() => { fixture.server.close(); removeDir(fixture.dir) })
  const stream = new EventStream({ eventSocket: fixture.path })
  t.after(() => stream.close())
  await assert.rejects(stream.next({ timeoutMs: 40 }), (error: Error & { code?: string }) => error.code === 'TIMEOUT')
})

test('EventStream resolves null after the server ends a clean stream', async (t) => {
  const fixture = await socketFixture(['workspace>>1\n'])
  t.after(() => { fixture.server.close(); removeDir(fixture.dir) })
  const stream = new EventStream({ eventSocket: fixture.path })
  t.after(() => stream.close())
  assert.equal((await stream.next({ timeoutMs: 1000 }))?.event, 'workspace')
  assert.equal(await stream.next({ timeoutMs: 1000 }), null)
})

test('waitForEvent returns the first matching event', async (t) => {
  const fixture = await socketFixture(['workspace>>2\n', 'activewindow>>zen,Hi\n'])
  t.after(() => { fixture.server.close(); removeDir(fixture.dir) })
  const event = await waitForEvent({ eventSocket: fixture.path }, candidate => candidate.event === 'activewindow',
    { timeoutMs: 1000 })
  assert.equal(event.data, 'zen,Hi')
})

test('waitForEvent fails when the deadline passes without a match', async (t) => {
  const fixture = await socketFixture(['workspace>>2\n'], { end: false })
  t.after(() => { fixture.server.close(); removeDir(fixture.dir) })
  await assert.rejects(
    waitForEvent({ eventSocket: fixture.path }, () => false, { timeoutMs: 40 }),
    (error: Error & { code?: string }) => error.code === 'TIMEOUT',
  )
})
