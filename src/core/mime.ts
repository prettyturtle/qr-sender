/**
 * MIME resolution.
 *
 * `File.type` is empty surprisingly often — files dragged from an archive, from
 * some Linux file managers, from a terminal-created path. And when a transfer
 * arrives, the declared type came from a sender we do not trust. So the type is
 * resolved from three sources, most reliable first: the bytes themselves, the
 * filename extension, then whatever was declared.
 */

const BY_EXTENSION: Readonly<Record<string, string>> = {
  // text and code
  txt: 'text/plain', text: 'text/plain', log: 'text/plain',
  md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  // `.ts` is both TypeScript and MPEG transport stream; source code is by far
  // the likelier thing to hand-send, and a real stream is caught by sniffing.
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/javascript',
  json: 'application/json', jsonl: 'application/json', ndjson: 'application/json',
  xml: 'application/xml', svg: 'image/svg+xml',
  yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain', ini: 'text/plain',
  conf: 'text/plain', cfg: 'text/plain', env: 'text/plain', properties: 'text/plain',
  sh: 'text/plain', bash: 'text/plain', zsh: 'text/plain', fish: 'text/plain',
  py: 'text/plain', rb: 'text/plain', go: 'text/plain', rs: 'text/plain',
  java: 'text/plain', kt: 'text/plain', swift: 'text/plain', c: 'text/plain',
  h: 'text/plain', cpp: 'text/plain', hpp: 'text/plain', cs: 'text/plain',
  php: 'text/plain', sql: 'text/plain', graphql: 'text/plain', proto: 'text/plain',
  dockerfile: 'text/plain', makefile: 'text/plain', patch: 'text/plain', diff: 'text/plain',
  pem: 'text/plain', crt: 'text/plain', key: 'text/plain', pub: 'text/plain',
  srt: 'text/plain', vtt: 'text/plain',

  // images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',

  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  weba: 'audio/webm', aiff: 'audio/aiff', mid: 'audio/midi', midi: 'audio/midi',

  // video
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  ogv: 'video/ogg', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpg: 'video/mpeg',
  mpeg: 'video/mpeg',

  // documents and archives
  pdf: 'application/pdf',
  zip: 'application/zip', jar: 'application/zip', apk: 'application/zip',
  docx: 'application/zip', xlsx: 'application/zip', pptx: 'application/zip',
  gz: 'application/gzip', tgz: 'application/gzip', bz2: 'application/x-bzip2',
  xz: 'application/x-xz', tar: 'application/x-tar', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  epub: 'application/epub+zip', rtf: 'application/rtf',

  // fonts
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

export function mimeFromFilename(name: string): string | null {
  const lower = name.toLowerCase();
  const bare = lower.split('/').pop() ?? lower;
  if (bare === 'dockerfile' || bare === 'makefile' || bare.startsWith('.env')) return 'text/plain';
  const dot = bare.lastIndexOf('.');
  if (dot < 0 || dot === bare.length - 1) return null;
  const ext = bare.slice(dot + 1);
  return BY_EXTENSION[ext] ?? null;
}

function starts(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  return starts(bytes, [...text].map((c) => c.charCodeAt(0)), offset);
}

/** Container signatures, checked before any declared type is believed. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'audio/wav';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'AVI ')) return 'video/x-msvideo';
  if (ascii(bytes, 0, '%PDF-')) return 'application/pdf';
  if (ascii(bytes, 0, 'OggS')) return 'audio/ogg';
  if (ascii(bytes, 0, 'fLaC')) return 'audio/flac';
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (starts(bytes, [0x1f, 0x8b])) return 'application/gzip';
  if (starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (ascii(bytes, 0, 'Rar!')) return 'application/vnd.rar';
  if (starts(bytes, [0xff, 0xfb]) || starts(bytes, [0xff, 0xf3]) || ascii(bytes, 0, 'ID3')) return 'audio/mpeg';
  if (ascii(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
    return 'video/mp4';
  }
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return 'application/zip';
  }
  return null;
}

/** True when the declared type carries no information. */
export function isGenericMime(mime: string): boolean {
  return mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream';
}

/**
 * Bytes first, then the extension, then whatever was declared. A sender's
 * declared type is the least trustworthy of the three — it is attacker-controlled
 * on receive and frequently just empty on send.
 */
export function resolveMime(declared: string, name: string, bytes?: Uint8Array): string {
  const sniffed = bytes !== undefined && bytes.length >= 12 ? sniffMime(bytes) : null;
  if (sniffed !== null) {
    // Sniffing cannot tell a zip from the office formats and epub built on it.
    if (sniffed === 'application/zip') {
      const byName = mimeFromFilename(name);
      if (byName !== null && byName !== 'application/zip') return byName;
    }
    return sniffed;
  }
  const byName = mimeFromFilename(name);
  if (byName !== null) return byName;
  return isGenericMime(declared) ? 'application/octet-stream' : declared;
}
