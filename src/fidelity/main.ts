/**
 * SP-A — decoder fidelity check, runnable on any device from a URL.
 *
 * The whole wire format rests on one assumption: that a QR payload written in
 * base44 comes back out of a platform decoder character-for-character. That is
 * cheap to verify without a camera, because `BarcodeDetector.detect()` accepts a
 * canvas directly — so this page renders symbols and decodes them in a loop, and
 * can be opened on a borrowed Android phone or a remote device lab.
 *
 * It also runs the control experiment that justifies base44 existing at all
 * (raw bytes in QR byte mode, which `rawValue` cannot represent) and an A/B
 * throughput comparison against the wasm decoder.
 */

import QRCode from 'qrcode';
import { ALPHABET, decode, encode } from '../core/base44.js';
import { DEFAULT_PROFILE, QR_PROFILES } from '../core/params.js';
import { barcodeDetectorAvailable, createDetector, type FrameDetector } from '../platform/detect.js';

const root = document.getElementById('root')!;

const style = document.createElement('style');
style.textContent = `
  body { margin:0; font: 15px/1.55 system-ui, sans-serif; background:#0e0e11; color:#f2f2f5; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  p.sub { color:#a6a6b4; margin:0 0 20px; font-size:13px; }
  section { border:1px solid #2a2a33; border-radius:12px; padding:16px; margin-bottom:14px; background:#17171c; }
  h2 { font-size:14px; margin:0 0 10px; color:#a6a6b4; font-weight:600; }
  button { font:inherit; font-weight:600; background:#5b8cff; color:#0b0b0f; border:0;
           border-radius:8px; padding:11px 18px; cursor:pointer; min-height:44px; }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .verdict { font-weight:700; font-size:15px; }
  .pass { color:#4ade80; } .fail { color:#f87171; } .warn { color:#fbbf24; }
  pre { font: 12px/1.5 ui-monospace, monospace; white-space:pre-wrap; word-break:break-all;
        background:#0e0e11; border-radius:8px; padding:12px; margin:10px 0 0; max-height:340px; overflow:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid #2a2a33; }
  th { color:#74748a; font-weight:600; }
  canvas { display:none; }
`;
document.head.append(style);

root.innerHTML = `
  <main>
    <h1>Decoder fidelity check</h1>
    <p class="sub">Verifies that base44 payloads survive this device's QR decoder byte-for-byte. No camera required.</p>
    <section>
      <h2>Environment</h2>
      <pre id="env">detecting…</pre>
    </section>
    <section>
      <h2>1 &middot; base44 fidelity</h2>
      <div class="row">
        <button id="run-fidelity">Run</button>
        <span id="fidelity-verdict" class="verdict"></span>
      </div>
      <pre id="fidelity-log">not run</pre>
    </section>
    <section>
      <h2>2 &middot; Control: raw bytes in QR byte mode</h2>
      <div class="row">
        <button id="run-control">Run</button>
        <span id="control-verdict" class="verdict"></span>
      </div>
      <pre id="control-log">not run</pre>
    </section>
    <section>
      <h2>4 &middot; Parallel decode</h2>
      <div class="row">
        <button id="run-pool">Run</button>
        <span id="pool-verdict" class="verdict"></span>
      </div>
      <div id="pool-table"></div>
    </section>
    <section>
      <h2>3 &middot; Throughput A/B</h2>
      <div class="row">
        <button id="run-bench">Run</button>
        <span id="bench-verdict" class="verdict"></span>
      </div>
      <div id="bench-table"></div>
    </section>
    <canvas id="work"></canvas>
  </main>
`;

const canvas = document.getElementById('work') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

function render(segments: QRCode.QRCodeSegment[], version: number, scale = 5): void {
  const sym = QRCode.create(segments, { version, errorCorrectionLevel: 'L' });
  const size = sym.modules.size;
  const quiet = 4;
  const side = (size + quiet * 2) * scale;
  canvas.width = side;
  canvas.height = side;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000';
  const data = sym.modules.data as unknown as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x]) ctx.fillRect((quiet + x) * scale, (quiet + y) * scale, scale, scale);
    }
  }
}

function grab(): ImageData {
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function detectOnce(detector: FrameDetector): Promise<string | null> {
  // Constructing a BarcodeDetector per call used to fold instance-creation cost
  // into every timing sample, which understates the decoder's real ceiling.
  const found = await detector.detect(canvas, grab);
  return found.length > 0 ? found[0] : null;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

/** Cases most likely to expose trimming, case folding, or unicode normalisation. */
function fidelityCases(): string[] {
  const cases: string[] = [];
  cases.push(ALPHABET);
  cases.push(ALPHABET.repeat(10).slice(0, 300));
  for (const edge of ['...', ':::', '---', '$$$', '%%%', '***', '+++', '///', '00', 'ZZ']) {
    cases.push(`${edge}${ALPHABET}${edge}`.padEnd(90, '0'));
  }
  for (let i = 0; i < 40; i++) cases.push(encode(randomBytes(DEFAULT_PROFILE.frameBytes)));
  for (const p of Object.values(QR_PROFILES)) cases.push(encode(randomBytes(p.frameBytes)));
  return cases;
}

function versionFor(chars: number): number {
  for (const p of Object.values(QR_PROFILES)) if (chars <= p.chars) return p.version;
  return 40;
}

async function showEnvironment(): Promise<void> {
  const native = await barcodeDetectorAvailable();
  const formats = native
    ? await (window as unknown as { BarcodeDetector: { getSupportedFormats(): Promise<string[]> } }).BarcodeDetector.getSupportedFormats()
    : [];
  document.getElementById('env')!.textContent = [
    `userAgent        ${navigator.userAgent}`,
    `BarcodeDetector  ${native ? 'available' : 'NOT available (zxing-wasm will be used)'}`,
    `formats          ${formats.join(', ') || '-'}`,
    `secureContext    ${globalThis.isSecureContext}`,
    `devicePixelRatio ${globalThis.devicePixelRatio}`,
  ].join('\n');
}

async function runFidelity(): Promise<void> {
  const log = document.getElementById('fidelity-log')!;
  const verdict = document.getElementById('fidelity-verdict')!;
  log.textContent = 'running…';
  verdict.textContent = '';

  const detector = await createDetector();
  const cases = fidelityCases();
  const failures: string[] = [];

  for (let i = 0; i < cases.length; i++) {
    const text = cases[i];
    render([{ data: text, mode: 'alphanumeric' }], versionFor(text.length));
    const back = await detectOnce(detector);
    if (back === null) {
      failures.push(`#${i} len=${text.length}: no symbol detected`);
    } else if (back !== text) {
      const at = [...text].findIndex((c, j) => c !== back[j]);
      failures.push(
        `#${i} len=${text.length}: MISMATCH at ${at} — expected ${JSON.stringify(text.slice(Math.max(0, at - 4), at + 5))}, got ${JSON.stringify(back.slice(Math.max(0, at - 4), at + 5))} (returned length ${back.length})`,
      );
    } else if (decode(back) === null) {
      failures.push(`#${i}: text matched but base44 decode rejected it`);
    }
  }

  const ok = failures.length === 0;
  verdict.className = `verdict ${ok ? 'pass' : 'fail'}`;
  verdict.textContent = ok ? `PASS — ${cases.length}/${cases.length}` : `FAIL — ${failures.length}/${cases.length}`;
  log.textContent = [
    `decoder: ${detector.kind}`,
    `cases:   ${cases.length}`,
    '',
    ok
      ? 'Every payload round-tripped exactly. base44 is safe on this decoder.'
      : failures.join('\n'),
  ].join('\n');
  detector.close();
}

async function runControl(): Promise<void> {
  const log = document.getElementById('control-log')!;
  const verdict = document.getElementById('control-verdict')!;
  log.textContent = 'running…';

  const detector = await createDetector();
  const bytes = randomBytes(400);
  render([{ data: bytes, mode: 'byte' }], 25);
  const back = await detectOnce(detector);

  const encoder = new TextEncoder();
  const roundTripped = back === null ? null : encoder.encode(back);
  const lossless =
    roundTripped !== null &&
    roundTripped.length === bytes.length &&
    roundTripped.every((b, i) => b === bytes[i]);

  verdict.className = `verdict ${lossless ? 'warn' : 'pass'}`;
  verdict.textContent = lossless ? 'byte mode survived here' : 'byte mode is lossy, as expected';
  log.textContent = [
    `decoder: ${detector.kind}`,
    `sent:    ${bytes.length} raw bytes in QR byte mode`,
    `back:    ${back === null ? 'nothing detected' : `${roundTripped!.length} bytes after UTF-8 round-trip`}`,
    '',
    lossless
      ? 'This decoder happens to preserve raw bytes. base44 is still required, because\nBarcodeDetector on other platforms does not — the wire format cannot vary by device.'
      : 'Confirmed: raw bytes cannot survive a DOMString-only decoder API.\nThis is precisely why the payload is base44 text.',
  ].join('\n');
  detector.close();
}

async function runBench(): Promise<void> {
  const out = document.getElementById('bench-table')!;
  const verdict = document.getElementById('bench-verdict')!;
  out.textContent = 'running…';

  const text = encode(randomBytes(DEFAULT_PROFILE.frameBytes));
  const rows: Array<{ kind: string; fps: number; ok: boolean }> = [];

  for (const kind of ['barcode-detector', 'zxing-wasm'] as const) {
    let detector: FrameDetector;
    try {
      detector = await createDetector({ force: kind });
    } catch {
      rows.push({ kind: `${kind} (unavailable)`, fps: 0, ok: false });
      continue;
    }
    render([{ data: text, mode: 'alphanumeric' }], DEFAULT_PROFILE.version);

    // Warm up before timing so wasm instantiation is not counted.
    await detectOnce(detector);

    const start = performance.now();
    let n = 0;
    let ok = true;
    while (performance.now() - start < 3000) {
      const back = await detectOnce(detector);
      if (back !== text) ok = false;
      n++;
    }
    rows.push({ kind, fps: (n * 1000) / (performance.now() - start), ok });
    detector.close();
  }

  const native = rows.find((r) => r.kind === 'barcode-detector');
  const wasm = rows.find((r) => r.kind === 'zxing-wasm');
  const gap = native && wasm && wasm.fps > 0 ? native.fps / wasm.fps : null;

  verdict.className = 'verdict';
  verdict.textContent = gap === null ? '' : `native is ${gap.toFixed(2)}x the wasm rate`;

  out.innerHTML =
    `<table><tr><th>decoder</th><th>decodes/sec</th><th>lossless</th></tr>` +
    rows
      .map(
        (r) =>
          `<tr><td>${r.kind}</td><td>${r.fps.toFixed(1)}</td><td class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'yes' : 'no'}</td></tr>`,
      )
      .join('') +
    `</table>` +
    (gap !== null && gap < 1.15
      ? `<p class="sub" style="margin-top:10px">Gap is under 15% — the dual-path decoder is not earning its complexity on this device; a wasm-only build would be simpler.</p>`
      : '');
}

/**
 * Measures what the receiving pipeline actually gains from running decoders in
 * parallel. Serial decoding on one thread was the old ceiling; this shows the
 * multiple on the device in hand rather than in theory.
 */
async function runPool(): Promise<void> {
  const out = document.getElementById('pool-table')!;
  const verdict = document.getElementById('pool-verdict')!;
  out.textContent = 'running…';
  verdict.textContent = '';

  const { createDecodePool, decodeConcurrency } = await import('../platform/decodePool.js');
  const text = encode(randomBytes(DEFAULT_PROFILE.frameBytes));
  render([{ data: text, mode: 'alphanumeric' }], DEFAULT_PROFILE.version);

  const sizes = [1, 2, 4, decodeConcurrency()].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const rows: Array<{ size: number; fps: number; ok: boolean }> = [];

  for (const size of sizes) {
    const pool = await createDecodePool({ size });
    // Warm up so wasm instantiation is not counted.
    await pool.decode(await createImageBitmap(canvas));

    const start = performance.now();
    let done = 0;
    let ok = true;
    const inflight = new Set<Promise<void>>();
    while (performance.now() - start < 3000) {
      if (inflight.size >= size) {
        await Promise.race(inflight);
        continue;
      }
      const bitmap = await createImageBitmap(canvas);
      const task = pool.decode(bitmap).then(({ texts }) => {
        if (texts[0] !== text) ok = false;
        done++;
      });
      const wrapped = task.finally(() => inflight.delete(wrapped));
      inflight.add(wrapped);
    }
    await Promise.allSettled(inflight);
    rows.push({ size, fps: (done * 1000) / (performance.now() - start), ok });
    pool.close();
  }

  const base = rows[0];
  const best = rows.reduce((a, b) => (b.fps > a.fps ? b : a));
  verdict.className = 'verdict';
  verdict.textContent = `${(best.fps / base.fps).toFixed(2)}x at ${best.size} workers`;

  out.innerHTML =
    `<table><tr><th>workers</th><th>decodes/sec</th><th>speedup</th><th>lossless</th></tr>` +
    rows
      .map(
        (r) =>
          `<tr><td>${r.size}</td><td>${r.fps.toFixed(1)}</td><td>${(r.fps / base.fps).toFixed(2)}x</td>` +
          `<td class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'yes' : 'no'}</td></tr>`,
      )
      .join('') +
    `</table><p class="sub" style="margin-top:10px">Cores reported: ${navigator.hardwareConcurrency ?? '?'}</p>`;
}

document.getElementById('run-pool')!.addEventListener('click', (e) => {
  (e.target as HTMLButtonElement).disabled = true;
  void runPool().finally(() => ((e.target as HTMLButtonElement).disabled = false));
});

document.getElementById('run-fidelity')!.addEventListener('click', (e) => {
  (e.target as HTMLButtonElement).disabled = true;
  void runFidelity().finally(() => ((e.target as HTMLButtonElement).disabled = false));
});
document.getElementById('run-control')!.addEventListener('click', (e) => {
  (e.target as HTMLButtonElement).disabled = true;
  void runControl().finally(() => ((e.target as HTMLButtonElement).disabled = false));
});
document.getElementById('run-bench')!.addEventListener('click', (e) => {
  (e.target as HTMLButtonElement).disabled = true;
  void runBench().finally(() => ((e.target as HTMLButtonElement).disabled = false));
});

void showEnvironment();
