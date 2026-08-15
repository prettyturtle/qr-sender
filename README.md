# QR Sender

Move a file from one device to another with no network at all. One screen plays
a QR animation, another device's camera reads it. Nothing is uploaded; there is
no server.

The receiver can start watching **at any point** in the animation and still
reconstruct the whole file.

---

## Why this is not a QR generator

The interesting problem is not making a QR code. It is treating the
screen-to-camera path as a **one-way broadcast channel** and making it reliable
without any feedback from the receiver:

- The sender never learns which frames arrived, or even how many receivers there are.
- Receivers decode at wildly different rates — roughly 8 fps on Android Chrome,
  4 fps on iOS Safari — and the sender cannot know which is watching.
- A receiver may join halfway through and must still finish.
- Frames are lost to glare, blur, and focus hunting, unpredictably.

Everything below follows from those four facts.

## How it works

```
file ──▶ envelope ──▶ gzip? ──▶ AES-GCM? ──▶ segments ──▶ RS symbols ──▶ base44 ──▶ QR
                                                                                     │
                                                                                  screen
                                                                                     │
                                                                                  camera
                                                                                     ▼
file ◀── envelope ◀── gunzip ◀── decrypt ◀── reassemble ◀── RS decode ◀── base44 ◀── QR
```

### Systematic Reed-Solomon, not a fountain code

Each segment of the payload becomes `K = 96` source symbols, expanded to
`N = 255` symbols over GF(256) with a Cauchy generator matrix. The code is
**MDS**: *any* K of the N symbols reconstruct the segment. That is what makes an
arbitrary join point free — there is no "start of stream" to wait for.

A fountain code (LT) is the more obvious choice for this shape of problem, and
was the original design. It loses here:

| | LT fountain | Systematic Cauchy RS |
|---|---|---|
| Coding overhead | 1.3–1.6× at K≈100 | **1.0×** |
| Sender/receiver sync | shared PRNG and degree distribution, bit-exact | **none** — the symbol index is in the header |
| Receiver memory | encoded combinations, ~1.3× the output | **the output buffer itself** |
| Resume state | partial decoding matrix | **a bitmap** |
| Progressive preview | impossible until fully decoded | systematic symbols *are* the file |

Rateless codes shine at K ≥ 10⁴. At K ≈ 100 the soliton distribution's overhead
is pure loss, and the PRNG contract is a real hazard in a PWA: a service-worker
cached sender on v1.2 talking to a receiver on v1.3 would break silently if the
distribution ever changed. RS has no such contract — `symIndex` is on the wire.

The measured result, from `src/core/__tests__/simulation.test.ts`:

```
  r     loss  offset |  captured/needed  passes
  1.00  0.00       0 |            1.050       0     ← 1.05 is the manifest tax; coding overhead is exactly 1.0
  0.80  0.00       0 |            1.114       0     ← Android
  0.40  0.00       0 |            1.114       0     ← iOS Safari, worst supported receiver
  0.40  0.20       0 |            1.738       1     ← plus 20% frame loss
```

### The scheduler is the part that is easy to get wrong

Symbols are emitted **round-robin across every segment at once**, in bursts of 8:

```
for symbolIndex in shuffle(0..N-1):
    for segment in shuffle(0..segCount-1):
        emit(segment, symbolIndex)
```

The tempting alternative — a sliding window that advances once the sender has
emitted "enough" for the segments in flight — is broken. It silently assumes the
receiver captures every displayed frame. A receiver at 40% capture takes only
40% of that budget, cannot close the segment, and must hold partial state for
*every segment in the file* until the carousel comes back around. Peak receiver
memory stops being bounded by the window and becomes bounded by the file.

Round-robin fixes it: every frame is useful to every receiver until the whole
transfer completes, so nobody idles and nobody accumulates.

The design constraint that falls out:

```
r_min × N ≥ K        0.4 × 255 = 102 ≥ 96 ✓
```

With that satisfied, **every** receiver finishes within a single carousel pass,
whether it captures 100% or 40% of the frames. Below the floor
(`r < K/N = 0.376`) it degrades gracefully to a second pass rather than failing.

Segment order is reshuffled per burst so a receiver whose sampling period
happens to divide the segment count cannot systematically miss the same
segments forever.

### base44, and why not raw bytes

The Web Barcode Detection API — the hardware-accelerated decoder on Android
Chrome — exposes only `DetectedBarcode.rawValue`, a `DOMString`. There is no
byte accessor. Arbitrary binary in QR byte mode is destroyed by UTF-8 decoding
before you ever see it.

So the payload is text, in QR's alphanumeric mode (5.5 bits/char — denser than
Aztec's 5.0 or Data Matrix C40's 5.33). base45 (RFC 9285) packs 2 bytes into 3
characters because 45³ ≥ 65,536. The same holds for 44 characters
(44³ = 85,184 ≥ 65,536, and 44² = 1,936 ≥ 256 for the trailing byte), so
**dropping SPACE from the alphabet costs exactly zero density** while removing
all exposure to whitespace trimming by a platform decoder.

`src/core/__tests__/optical.test.ts` runs the whole chain — bytes → base44 → QR →
raster → real decoder → base44 → bytes — inside CI. `fidelity.html` runs the
same check against the *platform* decoder on a real device.

### Frame format

24-byte header, big-endian, followed by `blockSize` payload bytes.

```
 0  magic     2   'Q' 'S'
 2  version   1
 3  flags     1   manifest | compressed | encrypted
 4  streamId  4
 8  segIndex  2
10  symIndex  2
12  segCount  2
14  K         1
15  N         1
16  blockSize 2
18  reserved  2
20  crc32     4   over bytes 0..19 + payload
```

Every frame is self-describing, so the receiver needs no knowledge of the
sender's schedule and can start accumulating before the manifest arrives.

### Numbers

| | |
|---|---|
| QR profile | V25, ECC-L, 117 modules — 1,853 alphanumeric chars |
| Frame | 1,235 bytes after base44, minus 24 header = **1,211 payload** |
| Segment | 96 × 1,211 = **113 KB** |
| Playback | 10 or 12 fps (divisors of 30/60, so each frame is held ≥ 2 camera frames) |
| Goodput | 9.7 KB/s Android · 7.3 KB/s desktop · 4.8 KB/s iOS |
| 10 MB | **18–36 minutes**, depending on the receiving device |

That is modem-era throughput, and the UI says so honestly — it shows a *range*,
because the sender genuinely cannot know which device is watching. The verified
ceiling is 20 MB; beyond that the app warns and proceeds anyway.

## Privacy

Nothing leaves the browser. There is no server, no analytics, no upload path in
the code.

Encryption is optional and off by default, because most transfers are between
your own devices and friction there is not worth it. When it is on, PBKDF2-SHA256
(600k iterations) → AES-256-GCM, and **the filename and MIME type are encrypted
too** — they live in the inner envelope, not the broadcast manifest. A manifest
is displayed on screen for anyone to film; leaking `salary-2026.xlsx` there would
defeat the passphrase.

When encryption is off, the UI says plainly that anyone who films the screen can
read the file.

The claim is enforced, not just intended: there is no `fetch`, `XMLHttpRequest`,
`sendBeacon`, WebSocket or external URL anywhere in `src/`, the wasm decoder is
bundled rather than loaded from a CDN, and a Content-Security-Policy of
`default-src 'self'; connect-src 'self'` makes any future regression a browser
error rather than a silent leak.

## Threat model

A receiver points a camera at whatever happens to be on a screen, so **every byte
it parses is attacker-controlled** — header fields, manifest JSON, envelope
lengths, filename, MIME type. The defences that follow from that:

| Attack | Defence |
|---|---|
| Forged header sizes a 68 GB buffer | `segCount × K × blockSize` is checked against a 256 MB ceiling *before* allocation, and `blockSize` is capped at what any QR can actually carry |
| gzip bomb — 1 MB expands to 1 GB | Decompression aborts the moment output passes the limit, held to `plainSize` when the manifest advertises one |
| `kdf.iterations: 1e10` — PBKDF2 that never returns, triggered when the victim types a passphrase | Iteration count validated against a 5M cap before any key derivation |
| `NaN` fields slipping past range checks | Numeric fields go through `Number.isInteger`, not `typeof === 'number'` |
| Blob URL typed `text/html` scripting in this origin | Downloads are always `application/octet-stream`; previews only for an allowlist that excludes SVG |
| `report‮fdp.exe` reading as `reportexe.pdf` | Bidi overrides, isolates, zero-width marks and controls stripped from names before display and download |
| A second transmission appearing mid-scan | The receiver stays locked to its stream and asks — it never discards progress on its own |

Corrupted frames are detected by CRC and dropped; a corrupted *transfer* is
detected by the SHA-256 in the manifest and reported rather than silently saved.
Encryption additionally authenticates the whole payload through AES-GCM.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # full suite, Node only — no browser required
npm run build      # static output in dist/
npm run sim        # the K/N parameter sweep, with its table
```

The core is deliberately free of DOM and browser APIs, so the protocol, the
coding, the scheduler, and the whole loopback suite run in Node.

```
src/core/       protocol — no DOM, no browser APIs, fully testable in Node
  gf256         GF(2^8) arithmetic
  rs            systematic Cauchy Reed-Solomon
  base44        binary <-> QR-alphanumeric codec
  frame         24-byte header, CRC
  segment/…     manifest, envelope, payload assembly
  emitter       carousel scheduler (sending half)
  receiver      symbol accumulation and reconstruction
src/platform/   browser adapters, kept thin
  detect        BarcodeDetector | zxing-wasm behind one interface
  camera        capture loop, centre-crop ROI, decode-rate metering
  qrRender      alphanumeric-forced QR rendering
  storage       IndexedDB resume
src/app/        React UI
src/fidelity/   on-device decoder check (SP-A), shipped at /fidelity.html
```

### Test coverage map

| Test | Covers |
|---|---|
| `rs.test.ts` | GF(256) field laws, Cauchy invertibility, recovery from any K of N |
| `codec.test.ts` | base44 exhaustive round-trip, frame CRC single-bit detection, QR capacities against the real encoder |
| `optical.test.ts` | the full optical chain through a real QR decoder |
| `loopback.test.ts` | lossless, 30% loss, mid-join, 10% corruption, capture rate, compression, stream collision, encryption |
| `simulation.test.ts` | the K/N sweep and the capture-rate floor |
| `memory-resume.test.ts` | segment boundaries, sender memory constancy, resume across a snapshot |
| `hostile.test.ts` | forged headers, memory bombs, malformed manifests and envelopes, random-byte fuzzing |
| `hardening.test.ts` | decompression bombs, hostile KDF parameters, filename spoofing |

### Verifying on real devices

1. `npm run build && npx vite preview --host` (or deploy)
2. Open `/fidelity.html` on the target phone — no camera needed. It checks
   base44 fidelity against the platform decoder, runs the raw-byte control
   experiment, and benchmarks `BarcodeDetector` against `zxing-wasm`.
3. Open `/` on two devices and transfer something.

## Deploy

Static files, no server runtime. `npm run build` and serve `dist/`. HTTPS is
required — `getUserMedia` will not run otherwise.

## License

MIT
