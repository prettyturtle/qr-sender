/**
 * Small payloads.
 *
 * K used to be pinned at its ceiling, which meant a twenty-byte message was
 * padded out to 96 blocks of mostly zeroes and broadcast as a ten-second
 * animation. Two changes fix that: K is derived from the payload, and anything
 * that fits alongside its manifest in one frame becomes a single still QR.
 */

import { describe, expect, it } from 'vitest';
import { Emitter } from '../emitter.js';
import { chooseK, DEFAULT_K, DEFAULT_N, DEFAULT_PROFILE, FLAG_INLINE } from '../params.js';
import { buildPayload, openPayload } from '../payload.js';
import { Receiver } from '../receiver.js';
import { unpackFrame } from '../frame.js';
import { sha256Hex } from '../sha256.js';
import { randomBytes, runChannel } from './harness.js';

const BLOCK = DEFAULT_PROFILE.blockSize;

async function build(data: Uint8Array, name = 'note.txt', mime = 'text/plain', passphrase?: string) {
  return buildPayload({
    name,
    mime,
    data,
    k: DEFAULT_K,
    n: DEFAULT_N,
    blockSize: BLOCK,
    streamId: 0x51515151,
    ...(passphrase !== undefined ? { passphrase } : {}),
  });
}

function emitterFor(built: Awaited<ReturnType<typeof build>>): Emitter {
  return new Emitter({
    payload: built.payload,
    manifest: built.manifest,
    streamId: built.streamId,
    k: built.manifest.k,
    n: built.manifest.n,
    blockSize: built.manifest.blockSize,
  });
}

describe('chooseK', () => {
  it('scales with the payload and never exceeds the ceiling', () => {
    expect(chooseK(0, BLOCK)).toBe(1);
    expect(chooseK(1, BLOCK)).toBe(1);
    expect(chooseK(BLOCK, BLOCK)).toBe(1);
    expect(chooseK(BLOCK + 1, BLOCK)).toBe(2);
    expect(chooseK(50_000, BLOCK)).toBe(42);
    expect(chooseK(10_000_000, BLOCK)).toBe(DEFAULT_K);
  });
});

describe('a short message is a single still QR', () => {
  it('emits one unchanging frame', async () => {
    const built = await build(new TextEncoder().encode('hello, air gap'));
    const emitter = emitterFor(built);

    expect(emitter.isStatic).toBe(true);
    expect(built.manifest.k).toBe(1);
    expect(built.manifest.segCount).toBe(1);

    const first = emitter.next();
    for (let i = 0; i < 50; i++) expect(emitter.next()).toEqual(first);

    const parsed = unpackFrame(first)!;
    expect(parsed).not.toBeNull();
    expect(parsed.isInline).toBe(true);
    expect(parsed.header.flags & FLAG_INLINE).toBeTruthy();
  });

  it('completes from a single captured frame', async () => {
    const text = 'wifi:SSID=cafe;pass=hunter2;';
    const built = await build(new TextEncoder().encode(text));
    const emitter = emitterFor(built);

    const receiver = new Receiver();
    expect(receiver.ingest(emitter.next())).toBe('ok');

    // One frame. Not ninety-six.
    expect(receiver.complete).toBe(true);
    expect(receiver.framesAccepted).toBe(1);
    expect(receiver.verifyIntegrity()).toBe('verified');

    const env = await openPayload(receiver.payload(), receiver.manifest!);
    expect(new TextDecoder().decode(env.data)).toBe(text);
    expect(env.name).toBe('note.txt');
  });

  it('treats repeats of the same frame as duplicates', async () => {
    const built = await build(new TextEncoder().encode('x'));
    const emitter = emitterFor(built);
    const receiver = new Receiver();
    expect(receiver.ingest(emitter.next())).toBe('ok');
    expect(receiver.ingest(emitter.next())).toBe('duplicate');
    expect(receiver.progress.ratio).toBe(1);
  });

  it('works encrypted, still in one frame', async () => {
    const secret = 'token=abc123';
    const built = await build(new TextEncoder().encode(secret), 'secret.txt', 'text/plain', 'pw');
    const emitter = emitterFor(built);
    expect(emitter.isStatic).toBe(true);
    expect(built.manifest.name).toBeUndefined();

    const receiver = new Receiver();
    expect(receiver.ingest(emitter.next())).toBe('ok');
    expect(receiver.complete).toBe(true);
    const env = await openPayload(receiver.payload(), receiver.manifest!, 'pw');
    expect(new TextDecoder().decode(env.data)).toBe(secret);
    expect(env.name).toBe('secret.txt');
  });

  it('finds the boundary where animation takes over', async () => {
    // Just under a frame: still. Comfortably over: animated.
    const smallBuilt = await build(randomBytes(700, 1), 'a.bin', 'application/octet-stream');
    expect(emitterFor(smallBuilt).isStatic).toBe(true);

    const bigBuilt = await build(randomBytes(4000, 2), 'b.bin', 'application/octet-stream');
    const bigEmitter = emitterFor(bigBuilt);
    expect(bigEmitter.isStatic).toBe(false);
    expect(bigBuilt.manifest.k).toBe(4);
  });
});

describe('mid-size payloads no longer broadcast zero padding', () => {
  it('sizes K to the content instead of the ceiling', async () => {
    const data = randomBytes(50_000, 3);
    const built = await build(data, 'mid.bin', 'application/octet-stream');
    // 50KB needs 42 blocks. Padding to 96 would have more than doubled the transfer.
    expect(built.manifest.k).toBeLessThan(DEFAULT_K);
    expect(built.manifest.segCount).toBe(1);

    const res = runChannel(built.payload, built.manifest, built.streamId);
    expect(res.completed).toBe(true);
    expect(res.receiver.verifyIntegrity()).toBe('verified');
    // Symbols required must track the payload, not the ceiling.
    expect(res.receiver.progress.needed).toBe(built.manifest.k);

    const env = await openPayload(res.receiver.payload(), res.receiver.manifest!);
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
  });

  it('still round-trips through loss and a mid-stream join', async () => {
    const data = randomBytes(30_000, 4);
    const built = await build(data, 'mid2.bin', 'application/octet-stream');
    const res = runChannel(built.payload, built.manifest, built.streamId, {
      lossRate: 0.3,
      startOffset: 137,
      seed: 5,
    });
    expect(res.completed).toBe(true);
    expect(res.receiver.verifyIntegrity()).toBe('verified');
  });
});

describe('forged inline frames', () => {
  it('rejects an inline flag on a multi-block stream', async () => {
    const built = await build(randomBytes(4000, 6), 'c.bin', 'application/octet-stream');
    const emitter = emitterFor(built);
    const frame = emitter.next().slice();
    frame[3] |= FLAG_INLINE; // set the flag without the shape it promises
    expect(unpackFrame(frame)).toBeNull();
  });

  it('rejects an inline frame whose manifest disagrees with its header', async () => {
    const built = await build(new TextEncoder().encode('hi'));
    const emitter = emitterFor(built);
    const frame = emitter.next().slice();
    // Flip a byte inside the embedded manifest JSON; CRC catches it first, but
    // the receiver must not accept it either way.
    const receiver = new Receiver();
    frame[60] ^= 0xff;
    expect(receiver.ingest(frame)).toBe('invalid');
    expect(receiver.complete).toBe(false);
  });
});
