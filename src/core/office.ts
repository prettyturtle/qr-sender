/**
 * Office document extraction — Word, Excel, PowerPoint, and the OpenDocument
 * equivalents.
 *
 * All of them are ZIP archives full of XML, so the content can be pulled out
 * with the ZIP reader and a scanner over the markup. That matters here: these
 * are the formats an office worker actually sends, and showing them as "an
 * archive containing 42 entries" is the same as showing nothing.
 *
 * Text is extracted with a scanner rather than a DOM parser on purpose. There is
 * no DOMParser outside a browser, and this way the whole path is exercised by
 * the Node test suite alongside the rest of the protocol. Nothing here
 * interprets styling or layout — a preview answers "what is in this file", and
 * fidelity is what the download is for.
 */

import { readZipEntry, zipEntryNames } from './zip.js';

export interface DocumentText {
  kind: 'document';
  paragraphs: string[];
  truncated: boolean;
}

export interface SlideDeck {
  kind: 'slides';
  slides: Array<{ title: string; lines: string[] }>;
  truncated: boolean;
}

export interface Spreadsheet {
  kind: 'sheet';
  sheets: Array<{ name: string; rows: string[][] }>;
  truncated: boolean;
}

export type OfficeContent = DocumentText | SlideDeck | Spreadsheet;

export const MAX_PARAGRAPHS = 800;
export const MAX_SLIDES = 60;
export const MAX_SHEETS = 8;
export const MAX_ROWS = 300;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Concatenate the text of every `<tag>` in document order. */
function textOf(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  for (const m of xml.matchAll(re)) out += decodeXmlText(m[1]);
  return out;
}

function splitBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

const decoder = new TextDecoder('utf-8', { fatal: false });

async function readXml(zip: Uint8Array, name: string): Promise<string | null> {
  const bytes = await readZipEntry(zip, name);
  return bytes === null ? null : decoder.decode(bytes);
}

/** Word: paragraphs are `<w:p>`, runs of text inside them are `<w:t>`. */
export async function extractDocx(zip: Uint8Array): Promise<DocumentText | null> {
  const xml = await readXml(zip, 'word/document.xml');
  if (xml === null) return null;

  const paragraphs: string[] = [];
  for (const block of splitBlocks(xml, 'w:p')) {
    // A tab in the markup is real whitespace in the document.
    const text = textOf(block.replace(/<w:tab\b[^>]*\/?>/g, '\t'), 'w:t').trim();
    if (text.length > 0) paragraphs.push(text);
    if (paragraphs.length >= MAX_PARAGRAPHS) return { kind: 'document', paragraphs, truncated: true };
  }
  return { kind: 'document', paragraphs, truncated: false };
}

/** OpenDocument text: paragraphs and headings both hold their text directly. */
export async function extractOdfText(zip: Uint8Array): Promise<DocumentText | null> {
  const xml = await readXml(zip, 'content.xml');
  if (xml === null) return null;

  const paragraphs: string[] = [];
  for (const m of xml.matchAll(/<text:(p|h)(?:\s[^>]*)?>([\s\S]*?)<\/text:\1>/g)) {
    const text = decodeXmlText(m[2].replace(/<[^>]+>/g, '')).trim();
    if (text.length > 0) paragraphs.push(text);
    if (paragraphs.length >= MAX_PARAGRAPHS) return { kind: 'document', paragraphs, truncated: true };
  }
  return { kind: 'document', paragraphs, truncated: false };
}

function slideNumber(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m === null ? Number.MAX_SAFE_INTEGER : Number(m[1]);
}

/** PowerPoint: one XML per slide, all text in `<a:t>`. */
export async function extractPptx(zip: Uint8Array): Promise<SlideDeck | null> {
  const names = zipEntryNames(zip)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (names.length === 0) return null;

  const slides: SlideDeck['slides'] = [];
  for (const name of names.slice(0, MAX_SLIDES)) {
    const xml = await readXml(zip, name);
    if (xml === null) continue;
    // Each `<a:p>` is a paragraph; the first non-empty one reads as the title.
    const lines = splitBlocks(xml, 'a:p')
      .map((block) => textOf(block, 'a:t').trim())
      .filter((line) => line.length > 0);
    slides.push({ title: lines[0] ?? '', lines: lines.slice(1) });
  }
  return { kind: 'slides', slides, truncated: names.length > MAX_SLIDES };
}

/** `AB` -> 27. Excel addresses columns in bijective base-26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) break;
    n = n * 26 + v;
  }
  return Math.max(0, n - 1);
}

/**
 * Excel: cell values are indices into a shared string table unless the cell says
 * otherwise, and empty cells are simply absent — so columns have to be placed by
 * their address rather than by counting.
 */
export async function extractXlsx(zip: Uint8Array): Promise<Spreadsheet | null> {
  const names = zipEntryNames(zip);
  const sheetFiles = names
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (sheetFiles.length === 0) return null;

  const sharedXml = await readXml(zip, 'xl/sharedStrings.xml');
  const shared =
    sharedXml === null ? [] : splitBlocks(sharedXml, 'si').map((si) => textOf(si, 't'));

  const workbookXml = await readXml(zip, 'xl/workbook.xml');
  const sheetNames = workbookXml === null ? [] : [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXmlText(m[1]));

  const sheets: Spreadsheet['sheets'] = [];
  for (let i = 0; i < Math.min(sheetFiles.length, MAX_SHEETS); i++) {
    const xml = await readXml(zip, sheetFiles[i]);
    if (xml === null) continue;

    const rows: string[][] = [];
    for (const rowXml of splitBlocks(xml, 'row')) {
      const row: string[] = [];
      for (const cell of rowXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const body = cell[2] ?? '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '';
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

        let value: string;
        if (type === 's') {
          const idx = Number(textOf(body, 'v'));
          value = shared[idx] ?? '';
        } else if (type === 'inlineStr') {
          value = textOf(body, 't');
        } else {
          value = textOf(body, 'v');
        }

        const col = ref.length > 0 ? columnIndex(ref) : row.length;
        while (row.length < col) row.push('');
        row[col] = value;
      }
      rows.push(row);
      if (rows.length >= MAX_ROWS) break;
    }

    sheets.push({ name: sheetNames[i] ?? `Sheet ${i + 1}`, rows });
  }

  return { kind: 'sheet', sheets, truncated: sheetFiles.length > MAX_SHEETS };
}

/** OpenDocument spreadsheet: `<table:table>` of `<table:table-row>`. */
export async function extractOdfSheet(zip: Uint8Array): Promise<Spreadsheet | null> {
  const xml = await readXml(zip, 'content.xml');
  if (xml === null) return null;

  const sheets: Spreadsheet['sheets'] = [];
  const tables = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)];
  for (const table of tables.slice(0, MAX_SHEETS)) {
    const name = decodeXmlText(/\btable:name="([^"]*)"/.exec(table[1])?.[1] ?? 'Sheet');
    const rows: string[][] = [];
    for (const rowXml of splitBlocks(table[2], 'table:table-row')) {
      const row: string[] = [];
      for (const cell of rowXml.matchAll(/<table:table-cell\b([^>]*)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)) {
        const repeat = Number(/\btable:number-columns-repeated="(\d+)"/.exec(cell[1])?.[1] ?? '1');
        const text = decodeXmlText((cell[2] ?? '').replace(/<[^>]+>/g, '')).trim();
        for (let r = 0; r < Math.min(repeat, 64); r++) row.push(text);
      }
      while (row.length > 0 && row[row.length - 1] === '') row.pop();
      rows.push(row);
      if (rows.length >= MAX_ROWS) break;
    }
    sheets.push({ name, rows });
  }
  return { kind: 'sheet', sheets, truncated: tables.length > MAX_SHEETS };
}

/** OpenDocument presentation: one `<draw:page>` per slide. */
export async function extractOdfSlides(zip: Uint8Array): Promise<SlideDeck | null> {
  const xml = await readXml(zip, 'content.xml');
  if (xml === null) return null;

  const pages = [...xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)];
  if (pages.length === 0) return null;

  const slides: SlideDeck['slides'] = [];
  for (const page of pages.slice(0, MAX_SLIDES)) {
    const lines: string[] = [];
    for (const m of page[1].matchAll(/<text:(p|span)(?:\s[^>]*)?>([\s\S]*?)<\/text:\1>/g)) {
      const text = decodeXmlText(m[2].replace(/<[^>]+>/g, '')).trim();
      if (text.length > 0 && !lines.includes(text)) lines.push(text);
    }
    slides.push({ title: lines[0] ?? '', lines: lines.slice(1) });
  }
  return { kind: 'slides', slides, truncated: pages.length > MAX_SLIDES };
}

export const OFFICE_MIME_HANDLERS: Readonly<
  Record<string, (zip: Uint8Array) => Promise<OfficeContent | null>>
> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': extractDocx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': extractXlsx,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': extractPptx,
  'application/vnd.oasis.opendocument.text': extractOdfText,
  'application/vnd.oasis.opendocument.spreadsheet': extractOdfSheet,
  'application/vnd.oasis.opendocument.presentation': extractOdfSlides,
};

export function isOfficeMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(OFFICE_MIME_HANDLERS, mime);
}
