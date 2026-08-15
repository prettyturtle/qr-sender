/**
 * Office extraction.
 *
 * Word, Excel and PowerPoint are the formats an office worker actually sends,
 * and showing them as "an archive containing 42 entries" is the same as showing
 * nothing. These build real OOXML/ODF containers and read them back through the
 * same path the app uses.
 */

import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  columnIndex,
  decodeXmlText,
  extractDocx,
  extractOdfSheet,
  extractOdfSlides,
  extractOdfText,
  extractPptx,
  extractXlsx,
  isOfficeMime,
} from '../office.js';
import { readZipEntry, zipEntryNames } from '../zip.js';
import { resolveMime } from '../mime.js';
import { classifyPreview } from '../../app/preview.js';

const enc = new TextEncoder();

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
    lv.setUint16(8, 8, true);
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

  const out = new Uint8Array(offset + centralSize + 22);
  let o = 0;
  for (const b of [...locals, ...centrals, eocd]) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

describe('zip entry extraction', () => {
  it('inflates a deflated entry', async () => {
    const zip = makeZip([{ name: 'a/b.txt', content: 'hello '.repeat(200) }]);
    const bytes = await readZipEntry(zip, 'a/b.txt');
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('hello '.repeat(200));
  });

  it('returns null for a missing entry and lists what is there', async () => {
    const zip = makeZip([{ name: 'x.txt', content: 'x' }]);
    expect(await readZipEntry(zip, 'nope.txt')).toBeNull();
    expect(zipEntryNames(zip)).toEqual(['x.txt']);
  });
});

describe('xml helpers', () => {
  it('decodes entities including numeric ones', () => {
    expect(decodeXmlText('a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;')).toBe('a & b <c> "d" A B');
  });

  it('converts spreadsheet column letters', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('Z')).toBe(25);
    expect(columnIndex('AA')).toBe(26);
    expect(columnIndex('AB')).toBe(27);
  });
});

describe('Word', () => {
  const docx = makeZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    {
      name: 'word/document.xml',
      content:
        '<w:document><w:body>' +
        '<w:p><w:r><w:t>First para</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Split </w:t></w:r><w:r><w:t>across runs</w:t></w:r></w:p>' +
        '<w:p></w:p>' +
        '<w:p><w:r><w:t>Ampersand &amp; entity</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    },
  ]);

  it('extracts paragraphs, joining runs and dropping empties', async () => {
    const doc = (await extractDocx(docx))!;
    expect(doc).not.toBeNull();
    expect(doc.kind).toBe('document');
    expect(doc.paragraphs).toEqual(['First para', 'Split across runs', 'Ampersand & entity']);
    expect(doc.truncated).toBe(false);
  });

  it('is routed there by extension, since sniffing only ever says "zip"', () => {
    const mime = resolveMime('', 'report.docx', docx);
    expect(mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(isOfficeMime(mime)).toBe(true);
    expect(classifyPreview({ mime, name: 'report.docx', bytes: docx, dark: true }).kind).toBe('office');
  });
});

describe('PowerPoint', () => {
  const slide = (title: string, body: string): string =>
    `<p:sld><p:cSld><p:spTree>` +
    `<p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sld>`;

  const pptx = makeZip([
    { name: 'ppt/slides/slide10.xml', content: slide('Tenth', 'ten body') },
    { name: 'ppt/slides/slide2.xml', content: slide('Second', 'two body') },
    { name: 'ppt/slides/slide1.xml', content: slide('First', 'one body') },
  ]);

  it('extracts slides in numeric order, not lexicographic', async () => {
    const deck = (await extractPptx(pptx))!;
    expect(deck).not.toBeNull();
    expect(deck.slides.map((s) => s.title)).toEqual(['First', 'Second', 'Tenth']);
    expect(deck.slides[0].lines).toEqual(['one body']);
  });

  it('is classified as an office document', () => {
    const mime = resolveMime('', 'deck.pptx', pptx);
    expect(classifyPreview({ mime, name: 'deck.pptx', bytes: pptx, dark: true }).kind).toBe('office');
  });
});

describe('Excel', () => {
  const xlsx = makeZip([
    { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="Budget"/></sheets></workbook>' },
    {
      name: 'xl/sharedStrings.xml',
      content: '<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Coffee</t></si></sst>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        // Column B skipped entirely, then a value in C — sparse cells must land
        // in the right column rather than shuffling left.
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4200</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Inline</t></is></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);

  it('resolves shared strings and places sparse cells by address', async () => {
    const book = (await extractXlsx(xlsx))!;
    expect(book).not.toBeNull();
    expect(book.sheets).toHaveLength(1);
    expect(book.sheets[0].name).toBe('Budget');
    expect(book.sheets[0].rows[0]).toEqual(['Item', 'Cost']);
    expect(book.sheets[0].rows[1]).toEqual(['Coffee', '', '4200']);
    expect(book.sheets[0].rows[2]).toEqual(['Inline']);
  });

  it('is classified as an office document', () => {
    const mime = resolveMime('', 'budget.xlsx', xlsx);
    expect(classifyPreview({ mime, name: 'budget.xlsx', bytes: xlsx, dark: true }).kind).toBe('office');
  });
});

describe('OpenDocument', () => {
  it('extracts text from an odt', async () => {
    const odt = makeZip([
      {
        name: 'content.xml',
        content:
          '<office:document-content><office:body><office:text>' +
          '<text:h>Heading</text:h><text:p>Body <text:span>span</text:span></text:p>' +
          '</office:text></office:body></office:document-content>',
      },
    ]);
    const doc = (await extractOdfText(odt))!;
    expect(doc.paragraphs).toEqual(['Heading', 'Body span']);
  });

  it('extracts a table from an ods, expanding repeated cells', async () => {
    const ods = makeZip([
      {
        name: 'content.xml',
        content:
          '<office:document-content><table:table table:name="Data">' +
          '<table:table-row><table:table-cell><text:p>A</text:p></table:table-cell>' +
          '<table:table-cell table:number-columns-repeated="2"><text:p>B</text:p></table:table-cell>' +
          '</table:table-row></table:table></office:document-content>',
      },
    ]);
    const book = (await extractOdfSheet(ods))!;
    expect(book.sheets[0].name).toBe('Data');
    expect(book.sheets[0].rows[0]).toEqual(['A', 'B', 'B']);
  });

  it('extracts slides from an odp', async () => {
    const odp = makeZip([
      {
        name: 'content.xml',
        content:
          '<office:document-content><draw:page draw:name="p1">' +
          '<text:p>Title here</text:p><text:p>Second line</text:p>' +
          '</draw:page></office:document-content>',
      },
    ]);
    const deck = (await extractOdfSlides(odp))!;
    expect(deck.slides[0].title).toBe('Title here');
    expect(deck.slides[0].lines).toEqual(['Second line']);
  });
});

describe('malformed containers', () => {
  it('returns null rather than throwing', async () => {
    const notAZip = new Uint8Array(500).fill(7);
    expect(await extractDocx(notAZip)).toBeNull();
    expect(await extractXlsx(notAZip)).toBeNull();
    expect(await extractPptx(notAZip)).toBeNull();
    expect(await extractOdfText(notAZip)).toBeNull();

    const emptyZip = makeZip([{ name: 'random.txt', content: 'x' }]);
    expect(await extractDocx(emptyZip)).toBeNull();
    expect(await extractPptx(emptyZip)).toBeNull();
  });
});
