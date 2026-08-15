/**
 * Preview pipeline: type resolution, archive listing, markup rendering, and the
 * routing that decides what a received file turns into on screen.
 *
 * The invariant worth protecting is that *every* input produces something
 * viewable — the hex fallback exists so "no preview available" is unreachable.
 */

import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { isGenericMime, mimeFromFilename, resolveMime, sniffMime } from '../mime.js';
import { readZipListing } from '../zip.js';
import { escapeHtml, renderMarkdown } from '../../app/markdown.js';
import { classifyPreview, hexDump, parseDelimited } from '../../app/preview.js';
import { randomBytes } from './harness.js';

const enc = new TextEncoder();

function bytesOf(...parts: Array<number[] | string>): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') flat.push(...enc.encode(p));
    else flat.push(...p);
  }
  return Uint8Array.from(flat);
}

/** Minimal ZIP writer — enough structure for the central-directory reader. */
function makeZip(entries: Array<{ name: string; content: string }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const raw = enc.encode(e.content);
    const deflated = new Uint8Array(deflateRawSync(raw));

    const local = new Uint8Array(30 + nameBytes.length + deflated.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true); // deflate
    lv.setUint32(18, deflated.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(deflated, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, deflated.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of [...locals, ...centrals, eocd]) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

describe('mime resolution', () => {
  it('maps the extensions people actually send', () => {
    expect(mimeFromFilename('a.md')).toBe('text/markdown');
    expect(mimeFromFilename('a.MP4')).toBe('video/mp4');
    expect(mimeFromFilename('song.flac')).toBe('audio/flac');
    expect(mimeFromFilename('sheet.csv')).toBe('text/csv');
    expect(mimeFromFilename('page.html')).toBe('text/html');
    expect(mimeFromFilename('icon.svg')).toBe('image/svg+xml');
    expect(mimeFromFilename('deck.pptx')).toBe('application/zip');
    expect(mimeFromFilename('font.woff2')).toBe('font/woff2');
    expect(mimeFromFilename('Dockerfile')).toBe('text/plain');
    expect(mimeFromFilename('.env')).toBe('text/plain');
    expect(mimeFromFilename('noext')).toBeNull();
  });

  it('sniffs container signatures', () => {
    expect(sniffMime(bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('image/png');
    expect(sniffMime(bytesOf([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(bytesOf('%PDF-1.7 rest'))).toBe('application/pdf');
    expect(sniffMime(bytesOf('OggS', [0, 0, 0, 0, 0, 0, 0, 0]))).toBe('audio/ogg');
    expect(sniffMime(bytesOf('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('audio/wav');
    expect(sniffMime(bytesOf('RIFF', [0, 0, 0, 0], 'WEBP'))).toBe('image/webp');
    expect(sniffMime(bytesOf([0, 0, 0, 0x18], 'ftyp', 'isom'))).toBe('video/mp4');
    expect(sniffMime(bytesOf([0, 0, 0, 0x18], 'ftyp', 'M4A '))).toBe('audio/mp4');
    expect(sniffMime(bytesOf([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('application/gzip');
    expect(sniffMime(randomBytes(64, 9))).not.toBe('image/png');
  });

  it('prefers bytes, then extension, then the declared type', () => {
    const png = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    // A sender claiming text/plain for PNG bytes does not get to decide.
    expect(resolveMime('text/plain', 'photo.txt', png)).toBe('image/png');
    // Empty type, recognisable name.
    expect(resolveMime('', 'notes.md', enc.encode('# hi'))).toBe('text/markdown');
    // Neither bytes nor name help.
    expect(resolveMime('application/x-custom', 'blob', randomBytes(64, 3))).toBe('application/x-custom');
    expect(resolveMime('', 'blob', randomBytes(64, 4))).toBe('application/octet-stream');
  });

  it('keeps zip-based document formats distinct from plain archives', () => {
    const zip = makeZip([{ name: 'word/document.xml', content: '<w/>' }]);
    expect(resolveMime('', 'report.docx', zip)).toBe('application/zip');
    expect(resolveMime('', 'book.epub', zip)).toBe('application/epub+zip');
  });

  it('recognises useless declared types', () => {
    expect(isGenericMime('')).toBe(true);
    expect(isGenericMime('application/octet-stream')).toBe(true);
    expect(isGenericMime('image/png')).toBe(false);
  });
});

describe('zip listing', () => {
  it('lists entries with their uncompressed sizes', () => {
    const zip = makeZip([
      { name: 'readme.txt', content: 'hello world' },
      { name: 'src/', content: '' },
      { name: 'src/main.ts', content: 'export const a = 1;' },
    ]);
    const listing = readZipListing(zip)!;
    expect(listing).not.toBeNull();
    expect(listing.entries.map((e) => e.name)).toEqual(['readme.txt', 'src/', 'src/main.ts']);
    expect(listing.entries[0].uncompressedSize).toBe(11);
    expect(listing.entries[1].directory).toBe(true);
    expect(listing.truncated).toBe(false);
  });

  it('returns null rather than throwing on non-archives', () => {
    expect(readZipListing(randomBytes(500, 1))).toBeNull();
    expect(readZipListing(new Uint8Array(4))).toBeNull();
  });

  it('survives a forged directory offset', () => {
    const zip = makeZip([{ name: 'a.txt', content: 'x' }]);
    // Point the central directory past the end of the file.
    new DataView(zip.buffer).setUint32(zip.length - 22 + 16, 0xffff0000, true);
    expect(() => readZipListing(zip)).not.toThrow();
    expect(readZipListing(zip)?.entries).toEqual([]);
  });
});

describe('markdown rendering', () => {
  it('escapes every character before applying the grammar', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('drops javascript: and data: links', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href');
    expect(renderMarkdown('[x](data:text/html,<script>)')).not.toContain('href');
    expect(renderMarkdown('[ok](https://example.com)')).toContain('href="https://example.com"');
  });

  it('renders the constructs people use', () => {
    const html = renderMarkdown(
      ['# Title', '', 'Some **bold** and `code`.', '', '- one', '- two', '', '> quote', '', '```', 'raw <b>', '```'].join('\n'),
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote>quote</blockquote>');
    expect(html).toContain('<pre><code>raw &lt;b&gt;</code></pre>');
  });
});

describe('delimited parsing', () => {
  it('handles quoted fields, embedded delimiters and doubled quotes', () => {
    expect(parseDelimited('a,b\n1,2', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimited('"x,y",z', ',')).toEqual([['x,y', 'z']]);
    expect(parseDelimited('"say ""hi""",z', ',')).toEqual([['say "hi"', 'z']]);
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('hex dump', () => {
  it('formats offset, hex and printable columns', () => {
    const { body } = hexDump(enc.encode('Hello!'));
    expect(body.startsWith('00000000  48 65 6c 6c 6f 21')).toBe(true);
    expect(body).toContain('Hello!');
  });

  it('marks truncation', () => {
    expect(hexDump(randomBytes(9000, 2)).truncated).toBe(true);
  });
});

describe('classification covers every input', () => {
  const cases: Array<[string, string, Uint8Array, string]> = [
    ['image/png', 'a.png', bytesOf([0x89, 0x50, 0x4e, 0x47]), 'image'],
    ['image/svg+xml', 'a.svg', enc.encode('<svg/>'), 'image'],
    ['audio/mpeg', 'a.mp3', randomBytes(32, 1), 'audio'],
    ['video/mp4', 'a.mp4', randomBytes(32, 2), 'video'],
    ['application/pdf', 'a.pdf', enc.encode('%PDF-1.4'), 'pdf'],
    ['font/woff2', 'a.woff2', randomBytes(32, 3), 'font'],
    ['text/markdown', 'a.md', enc.encode('# hi'), 'markup'],
    ['text/html', 'a.html', enc.encode('<p>hi</p>'), 'markup'],
    ['text/csv', 'a.csv', enc.encode('a,b\n1,2'), 'table'],
    ['application/json', 'a.json', enc.encode('{"a":1}'), 'text'],
    ['text/plain', 'a.txt', enc.encode('plain'), 'text'],
    ['application/octet-stream', 'a.bin', randomBytes(64, 4), 'hex'],
    ['application/x-unknown', 'weird', randomBytes(64, 5), 'hex'],
  ];

  for (const [mime, name, bytes, kind] of cases) {
    it(`${mime} -> ${kind}`, () => {
      expect(classifyPreview({ mime, name, bytes, dark: true }).kind).toBe(kind);
    });
  }

  it('lists a zip rather than dumping it', () => {
    const zip = makeZip([{ name: 'a.txt', content: 'x' }]);
    const p = classifyPreview({ mime: 'application/zip', name: 'a.zip', bytes: zip, dark: true });
    expect(p.kind).toBe('archive');
  });

  it('pretty-prints JSON', () => {
    const p = classifyPreview({
      mime: 'application/json',
      name: 'a.json',
      bytes: enc.encode('{"a":1,"b":[2,3]}'),
      dark: true,
    });
    expect(p.kind === 'text' && p.body.includes('\n  "a": 1')).toBe(true);
  });

  it('never leaves an input without something to look at', () => {
    for (const mime of ['', 'x/y', 'application/octet-stream', 'application/vnd.made-up']) {
      const p = classifyPreview({ mime, name: 'f', bytes: randomBytes(200, 8), dark: true });
      expect(p.kind, mime).not.toBe('none');
      expect(['hex', 'text', 'archive']).toContain(p.kind);
    }
  });
});
