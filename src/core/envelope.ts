/**
 * Inner envelope: the container that travels *inside* compression and encryption.
 *
 * Filename and MIME type live here rather than in the manifest so that turning
 * encryption on actually hides them. A manifest is broadcast in the clear —
 * anyone pointing a camera at the screen reads it — so leaking
 * `salary-2026.xlsx` there would defeat the point of the passphrase.
 *
 *   [u8 version=1][u16 nameLen][name utf8][u8 mimeLen][mime utf8][file bytes]
 */

const ENVELOPE_VERSION = 1;

export interface Envelope {
  name: string;
  mime: string;
  data: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function wrapEnvelope(name: string, mime: string, data: Uint8Array): Uint8Array {
  let nameBytes = enc.encode(name);
  if (nameBytes.length > 0xffff) nameBytes = nameBytes.subarray(0, 0xffff);
  let mimeBytes = enc.encode(mime);
  if (mimeBytes.length > 0xff) mimeBytes = mimeBytes.subarray(0, 0xff);

  const out = new Uint8Array(1 + 2 + nameBytes.length + 1 + mimeBytes.length + data.length);
  const view = new DataView(out.buffer);
  let o = 0;
  out[o++] = ENVELOPE_VERSION;
  view.setUint16(o, nameBytes.length);
  o += 2;
  out.set(nameBytes, o);
  o += nameBytes.length;
  out[o++] = mimeBytes.length;
  out.set(mimeBytes, o);
  o += mimeBytes.length;
  out.set(data, o);
  return out;
}

export function unwrapEnvelope(buf: Uint8Array): Envelope | null {
  if (buf.length < 4) return null;
  if (buf[0] !== ENVELOPE_VERSION) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 1;
  const nameLen = view.getUint16(o);
  o += 2;
  if (o + nameLen + 1 > buf.length) return null;
  const name = dec.decode(buf.subarray(o, o + nameLen));
  o += nameLen;
  const mimeLen = buf[o++];
  if (o + mimeLen > buf.length) return null;
  const mime = dec.decode(buf.subarray(o, o + mimeLen));
  o += mimeLen;
  return { name, mime, data: buf.subarray(o) };
}
