/**
 * Preview classification.
 *
 * The guiding rule is that **nothing arrives as an opaque blob**. Every branch
 * ends in something a person can look at: media plays, documents render, tables
 * become tables, archives list their contents, and anything left over is dumped
 * as annotated hex. "No preview available" is a failure of this module, not an
 * outcome.
 *
 * Two constraints shape how rendering happens:
 *
 *  - The content came off a stranger's screen, so anything that could execute is
 *    rendered inside a sandboxed frame with no same-origin access, and links are
 *    filtered before they ever reach markup.
 *  - The page's CSP forbids outside requests, so remote images and stylesheets
 *    inside received documents simply do not load. That is the privacy promise
 *    holding, not a bug — a received document cannot phone home.
 */

import { isOfficeMime } from '../core/office.js';
import { readZipListing, type ZipListing } from '../core/zip.js';
import { renderMarkdown, escapeHtml, previewDocument } from './markdown.js';

/** Text is cheap to render but not free; beyond this the browser starts to stutter. */
export const TEXT_LIMIT = 256 * 1024;
export const HEX_LIMIT = 4 * 1024;
export const TABLE_ROW_LIMIT = 500;

export type Preview =
  | { kind: 'image'; svgSource?: string }
  | { kind: 'audio' }
  | { kind: 'video' }
  | { kind: 'pdf' }
  | { kind: 'font'; family: string }
  | { kind: 'markup'; document: string; source: string; label: string }
  | { kind: 'text'; body: string; truncated: boolean; label: string }
  | { kind: 'table'; rows: string[][]; truncated: boolean }
  | { kind: 'archive'; listing: ZipListing }
  /** Word/Excel/PowerPoint and their OpenDocument equivalents; content is extracted asynchronously. */
  | { kind: 'office'; mime: string }
  | { kind: 'hex'; body: string; truncated: boolean };

const ZIP_CONTAINERS = new Set([
  'application/zip',
  'application/epub+zip',
  'application/vnd.hancom.hwpx',
  'application/java-archive',
]);

export function isTextual(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/x-sh' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  );
}

function decodeText(bytes: Uint8Array): { body: string; truncated: boolean } {
  const truncated = bytes.byteLength > TEXT_LIMIT;
  const slice = truncated ? bytes.subarray(0, TEXT_LIMIT) : bytes;
  return { body: new TextDecoder('utf-8', { fatal: false }).decode(slice), truncated };
}

/** RFC 4180 quoting: doubled quotes escape, and quoted fields may span lines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= TABLE_ROW_LIMIT) return rows;
    } else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Classic offset / hex / printable-ASCII dump. */
export function hexDump(bytes: Uint8Array, limit = HEX_LIMIT): { body: string; truncated: boolean } {
  const truncated = bytes.byteLength > limit;
  const view = truncated ? bytes.subarray(0, limit) : bytes;
  const lines: string[] = [];
  for (let o = 0; o < view.length; o += 16) {
    const chunk = view.subarray(o, o + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const text = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${o.toString(16).padStart(8, '0')}  ${hex}  ${text}`);
  }
  return { body: lines.join('\n'), truncated };
}

function languageLabel(mime: string, name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mime === 'application/json' || mime.endsWith('+json')) return 'JSON';
  if (mime === 'application/xml' || mime.endsWith('+xml')) return 'XML';
  if (mime === 'text/markdown') return 'Markdown';
  if (mime === 'text/html') return 'HTML';
  if (mime === 'text/csv') return 'CSV';
  return ext.length > 0 && ext.length <= 12 ? ext.toUpperCase() : 'Text';
}

export interface ClassifyOptions {
  mime: string;
  name: string;
  bytes: Uint8Array;
  /** Rendered documents follow the app's theme so they do not flash white. */
  dark: boolean;
}

export function classifyPreview({ mime, name, bytes, dark }: ClassifyOptions): Preview {
  if (mime === 'image/svg+xml') {
    // Safe in an <img>: SVG script never executes in image context. The source is
    // offered too, since a received SVG is as often something to read as to look at.
    const { body } = decodeText(bytes);
    return { kind: 'image', svgSource: body };
  }
  if (mime.startsWith('image/')) return { kind: 'image' };
  if (mime.startsWith('audio/')) return { kind: 'audio' };
  if (mime.startsWith('video/')) return { kind: 'video' };
  if (mime === 'application/pdf') return { kind: 'pdf' };
  if (mime.startsWith('font/') || mime === 'application/font-woff') {
    return { kind: 'font', family: 'ReceivedFont' };
  }

  if (mime === 'text/markdown') {
    const { body, truncated } = decodeText(bytes);
    return {
      kind: 'markup',
      document: previewDocument(renderMarkdown(body), dark),
      source: body + (truncated ? '\n…' : ''),
      label: 'Markdown',
    };
  }

  if (mime === 'text/html') {
    const { body, truncated } = decodeText(bytes);
    // The received markup is placed in the frame as-is; the sandbox, not
    // sanitisation, is what makes that safe.
    return { kind: 'markup', document: body, source: body + (truncated ? '\n…' : ''), label: 'HTML' };
  }

  if (mime === 'text/csv' || mime === 'text/tab-separated-values') {
    const { body, truncated } = decodeText(bytes);
    const rows = parseDelimited(body, mime === 'text/csv' ? ',' : '\t');
    if (rows.length > 0) return { kind: 'table', rows, truncated: truncated || rows.length >= TABLE_ROW_LIMIT };
  }

  if (isOfficeMime(mime)) return { kind: 'office', mime };

  if (ZIP_CONTAINERS.has(mime)) {
    const listing = readZipListing(bytes);
    if (listing !== null) return { kind: 'archive', listing };
  }

  if (isTextual(mime)) {
    let { body, truncated } = decodeText(bytes);
    if (!truncated && (mime === 'application/json' || mime.endsWith('+json'))) {
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* not valid JSON after all — show it verbatim */
      }
    }
    return { kind: 'text', body, truncated, label: languageLabel(mime, name) };
  }

  // Nothing else matched, but an opaque blob is never an acceptable answer.
  const dump = hexDump(bytes);
  return { kind: 'hex', body: dump.body, truncated: dump.truncated };
}

/** Self-contained document that shows a received font at several sizes. */
export function fontSpecimen(dataUrl: string, format: string, dark: boolean): string {
  const sample = 'The quick brown fox jumps over the lazy dog · 다람쥐 헌 쳇바퀴에 타고파 · 素早い茶色の狐';
  const body = `
    <style>
      @font-face { font-family: 'ReceivedFont'; src: url('${dataUrl}') format('${format}'); }
      .specimen { font-family: 'ReceivedFont', system-ui, sans-serif; }
    </style>
    <div class="specimen">
      <div style="font-size:34px;line-height:1.25">${escapeHtml(sample.slice(0, 44))}</div>
      <div style="font-size:22px;margin-top:12px">${escapeHtml(sample)}</div>
      <div style="font-size:15px;margin-top:12px">${escapeHtml(sample)}</div>
      <div style="font-size:15px;margin-top:16px">
        ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 &amp;@#$%*()[]{}
      </div>
    </div>`;
  return previewDocument(body, dark);
}

export function fontFormat(mime: string, name: string): string {
  if (mime === 'font/woff2' || name.endsWith('.woff2')) return 'woff2';
  if (mime === 'font/woff' || name.endsWith('.woff')) return 'woff';
  if (mime === 'font/otf' || name.endsWith('.otf')) return 'opentype';
  return 'truetype';
}
