/**
 * Result viewer for a completed receive.
 *
 * Preview breadth is the point of this screen: a file that crossed an optical
 * channel one QR frame at a time should not land as "no preview available".
 * Classification lives in `preview.ts`; this file is the rendering surface for
 * each outcome plus the object-URL discipline that keeps a 10MB blob from
 * leaking on every transfer.
 *
 * Safety model:
 *  - The download blob is always typed `application/octet-stream`, so a received
 *    `text/html` cannot be opened as script in this origin.
 *  - Media blobs carry their real type, which pins how the browser interprets
 *    them — a PDF frame renders as PDF regardless of what the bytes contain.
 *  - Anything that could execute is rendered `srcdoc` inside `sandbox=""`: an
 *    opaque origin, no scripts, no access back to the app.
 */

import { useEffect, useMemo, useState } from 'react';
import { sanitizeFilename, sanitizeMime } from '../../core/filename.js';
import { resolveMime } from '../../core/mime.js';
import { OFFICE_MIME_HANDLERS, type OfficeContent } from '../../core/office.js';
import { formatBytes } from '../estimate.js';
import { useT, type MessageKey, type Translate } from '../i18n.js';
import { nativePdfViewerAvailable, renderPdf, type RenderedPdf } from '../../platform/pdf.js';
import { classifyPreview, fontFormat, fontSpecimen, isTextual, type Preview } from '../preview.js';

export interface ViewerProps {
  name: string;
  mime: string;
  data: Uint8Array;
  integrity: 'verified' | 'mismatch' | 'unknown';
  onReset: () => void;
}

const DOWNLOAD_MIME = 'application/octet-stream';
/** Above this a base64 data URL costs more than a font specimen is worth. */
const FONT_INLINE_LIMIT = 4 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function prefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function Viewer({ name, mime, data, integrity, onReset }: ViewerProps): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [dark] = useState(prefersDark);

  // Both are sender-controlled. Clean them once, at the boundary where they are
  // shown and used, rather than trusting them through the render tree.
  const safeName = useMemo(() => sanitizeFilename(name), [name]);
  // Bytes outrank the declared type: `File.type` is empty surprisingly often on
  // the sending side, and on the receiving side it is simply untrusted.
  const resolved = useMemo(() => sanitizeMime(resolveMime(mime, safeName, data)), [mime, safeName, data]);

  const preview = useMemo<Preview>(
    () => classifyPreview({ mime: resolved, name: safeName, bytes: data, dark }),
    [resolved, safeName, data, dark],
  );

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [pdfPages, setPdfPages] = useState<RenderedPdf | null>(null);
  const [pdfState, setPdfState] = useState<'idle' | 'rendering' | 'failed'>('idle');
  const [office, setOffice] = useState<OfficeContent | null>(null);
  const [officeState, setOfficeState] = useState<'idle' | 'reading' | 'failed'>('idle');

  // Created inside effects rather than memos so a StrictMode double-mount hands
  // out fresh URLs instead of reusing ones it has already revoked.
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: DOWNLOAD_MIME }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [data]);

  const needsMediaUrl =
    preview.kind === 'image' || preview.kind === 'audio' || preview.kind === 'video' || preview.kind === 'pdf';

  useEffect(() => {
    if (!needsMediaUrl) {
      setMediaUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: resolved }));
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [data, resolved, needsMediaUrl]);

  // iOS Safari renders nothing for a PDF in an iframe, so where the platform
  // viewer is unavailable the pages are rasterised here instead. The renderer is
  // a dynamic import: a user who never receives a PDF never downloads it.
  const needsPdfFallback = preview.kind === 'pdf' && !nativePdfViewerAvailable();

  useEffect(() => {
    if (!needsPdfFallback) {
      setPdfPages(null);
      setPdfState('idle');
      return;
    }
    const controller = new AbortController();
    let rendered: RenderedPdf | null = null;
    setPdfState('rendering');
    void renderPdf(data, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) {
          for (const url of result.pages) URL.revokeObjectURL(url);
          return;
        }
        rendered = result;
        setPdfPages(result);
        setPdfState('idle');
      })
      .catch(() => {
        if (!controller.signal.aborted) setPdfState('failed');
      });
    return () => {
      controller.abort();
      for (const url of rendered?.pages ?? []) URL.revokeObjectURL(url);
    };
  }, [needsPdfFallback, data]);

  // Word, Excel and PowerPoint are ZIPs of XML, so their content is pulled out
  // here rather than shown as an archive listing — "42 entries" tells an office
  // worker nothing about their own document.
  useEffect(() => {
    if (preview.kind !== 'office') {
      setOffice(null);
      setOfficeState('idle');
      return;
    }
    let alive = true;
    setOfficeState('reading');
    const handler = OFFICE_MIME_HANDLERS[preview.mime];
    void handler(data)
      .then((content) => {
        if (!alive) return;
        if (content === null) setOfficeState('failed');
        else {
          setOffice(content);
          setOfficeState('idle');
        }
      })
      .catch(() => {
        if (alive) setOfficeState('failed');
      });
    return () => {
      alive = false;
    };
  }, [preview, data]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const fontDoc = useMemo(() => {
    if (preview.kind !== 'font' || data.byteLength > FONT_INLINE_LIMIT) return null;
    const url = `data:${resolved};base64,${toBase64(data)}`;
    return fontSpecimen(url, fontFormat(resolved, safeName), dark);
  }, [preview.kind, data, resolved, safeName, dark]);

  const textual = isTextual(resolved);
  const integrityKey: MessageKey | null =
    integrity === 'verified' ? 'recv.verified' : integrity === 'mismatch' ? 'recv.mismatch' : null;

  async function copy(): Promise<void> {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(data));
      setCopied(true);
    } catch {
      /* clipboard denied — the download button is still there */
    }
  }

  const canToggleSource =
    preview.kind === 'markup' || (preview.kind === 'image' && preview.svgSource !== undefined);

  return (
    <>
      <section className="card">
        <h2 className="card-title">{t('recv.complete')}</h2>
        <p className="mono">{safeName}</p>
        <dl className="stats">
          <div className="stat">
            <dt>{t('view.size')}</dt>
            <dd>{formatBytes(data.byteLength)}</dd>
          </div>
          <div className="stat">
            <dt>{t('view.type')}</dt>
            <dd style={{ fontSize: 13, wordBreak: 'break-all' }}>{resolved}</dd>
          </div>
          {integrityKey !== null && (
            <div className="stat">
              <dt>{t('view.integrity')}</dt>
              <dd>
                <span className={integrity === 'verified' ? 'badge ok' : 'badge danger'}>
                  {t(integrityKey)}
                </span>
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="card">
        <div className="preview-head">
          <h2 className="card-title" style={{ margin: 0 }}>
            {t('view.preview')}
          </h2>
          {canToggleSource && (
            <button type="button" className="btn btn-sm" onClick={() => setShowSource(!showSource)}>
              {showSource ? t('view.rendered') : t('view.source')}
            </button>
          )}
        </div>

        <PreviewBody
          preview={preview}
          showSource={showSource}
          mediaUrl={mediaUrl}
          fontDoc={fontDoc}
          pdfPages={pdfPages}
          pdfState={pdfState}
          office={office}
          officeState={officeState}
          name={safeName}
          t={t}
        />
      </section>

      <div className="btn-row">
        <a
          className="btn btn-primary"
          href={downloadUrl ?? undefined}
          download={safeName}
          aria-disabled={downloadUrl === null}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
        >
          {t('view.download')}
        </a>
        {textual && (
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? t('view.copied') : t('view.copy')}
          </button>
        )}
        <button type="button" className="btn" onClick={onReset}>
          {t('view.newTransfer')}
        </button>
      </div>
    </>
  );
}

interface BodyProps {
  preview: Preview;
  showSource: boolean;
  mediaUrl: string | null;
  fontDoc: string | null;
  pdfPages: RenderedPdf | null;
  pdfState: 'idle' | 'rendering' | 'failed';
  office: OfficeContent | null;
  officeState: 'idle' | 'reading' | 'failed';
  name: string;
  t: Translate;
}

function PreviewBody({
  preview,
  showSource,
  mediaUrl,
  fontDoc,
  pdfPages,
  pdfState,
  office,
  officeState,
  name,
  t,
}: BodyProps): JSX.Element {
  switch (preview.kind) {
    case 'image':
      if (showSource && preview.svgSource !== undefined) {
        return (
          <div className="preview-box">
            <pre>{preview.svgSource}</pre>
          </div>
        );
      }
      return (
        <div className="preview-box checkered">{mediaUrl !== null && <img src={mediaUrl} alt={name} />}</div>
      );

    case 'audio':
      return (
        <div className="preview-box">
          {mediaUrl !== null && (
            <audio controls preload="metadata" src={mediaUrl} style={{ width: '100%' }} />
          )}
        </div>
      );

    case 'video':
      return (
        <div className="preview-box flush">
          {mediaUrl !== null && <video controls preload="metadata" src={mediaUrl} playsInline />}
        </div>
      );

    case 'pdf':
      if (pdfPages !== null) {
        return (
          <>
            <div className="preview-box">
              {pdfPages.pages.map((url, i) => (
                <img key={url} src={url} alt={`${name} — ${i + 1}`} className="pdf-page" />
              ))}
            </div>
            <p className="mono" style={{ marginBottom: 0 }}>
              {t('view.pdfPages', { shown: pdfPages.pages.length, total: pdfPages.totalPages })}
            </p>
          </>
        );
      }
      if (pdfState === 'rendering') {
        return (
          <p className="notice">
            <span className="spinner" aria-hidden="true" />
            {t('view.pdfRendering')}
          </p>
        );
      }
      if (pdfState === 'failed') return <p className="notice">{t('view.pdfFailed')}</p>;
      // The blob's declared type pins interpretation, so the frame renders as a
      // PDF whatever the bytes are. No sandbox here: an opaque origin cannot load
      // a blob URL this document created, which would leave the frame blank.
      return (
        <div className="preview-box flush">
          {mediaUrl !== null && <iframe src={mediaUrl} title={t('view.preview')} className="doc-frame" />}
        </div>
      );

    case 'font':
      return fontDoc === null ? (
        <p className="notice">{t('view.noPreview')}</p>
      ) : (
        <div className="preview-box flush">
          <iframe srcDoc={fontDoc} sandbox="" title={t('view.preview')} className="doc-frame" />
        </div>
      );

    case 'markup':
      if (showSource) {
        return (
          <div className="preview-box">
            <pre>{preview.source}</pre>
          </div>
        );
      }
      return (
        <>
          <div className="preview-box flush">
            <iframe
              srcDoc={preview.document}
              sandbox=""
              referrerPolicy="no-referrer"
              title={t('view.preview')}
              className="doc-frame"
            />
          </div>
          <p className="mono" style={{ marginBottom: 0 }}>
            {t('view.sandboxNote')}
          </p>
        </>
      );

    case 'table': {
      const head = preview.rows[0] ?? [];
      const rest = preview.rows.slice(1);
      return (
        <>
          <div className="preview-box flush scroll-x">
            <table className="data-table">
              <thead>
                <tr>
                  {head.map((cell, i) => (
                    <th key={i}>{cell}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rest.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mono" style={{ marginBottom: 0 }}>
            {t('view.rows', { n: preview.rows.length })}
            {preview.truncated ? ` · ${t('view.truncated')}` : ''}
          </p>
        </>
      );
    }

    case 'archive':
      return (
        <>
          <div className="preview-box flush scroll-x">
            <table className="data-table">
              <tbody>
                {preview.listing.entries.map((e, i) => (
                  <tr key={i}>
                    <td style={{ wordBreak: 'break-all' }}>
                      {e.directory ? '📁 ' : ''}
                      {e.name}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {e.directory ? '' : formatBytes(e.uncompressedSize)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mono" style={{ marginBottom: 0 }}>
            {t('view.entries', { n: preview.listing.entries.length })}
            {preview.listing.truncated ? ` · ${t('view.truncated')}` : ''}
          </p>
        </>
      );

    case 'office':
      if (office === null) {
        if (officeState === 'failed') return <p className="notice">{t('view.officeFailed')}</p>;
        return (
          <p className="notice">
            <span className="spinner" aria-hidden="true" />
            {t('view.officeReading')}
          </p>
        );
      }
      if (office.kind === 'document') {
        return (
          <>
            <div className="preview-box">
              <div className="doc-text">
                {office.paragraphs.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </div>
            <p className="mono" style={{ marginBottom: 0 }}>
              {t('view.paragraphs', { n: office.paragraphs.length })}
              {office.truncated ? ` · ${t('view.truncated')}` : ''}
            </p>
          </>
        );
      }
      if (office.kind === 'slides') {
        return (
          <>
            <div className="preview-box">
              {office.slides.map((slide, i) => (
                <section key={i} className="slide">
                  <h3>
                    <span className="slide-no">{i + 1}</span>
                    {slide.title}
                  </h3>
                  {slide.lines.map((line, j) => (
                    <p key={j}>{line}</p>
                  ))}
                </section>
              ))}
            </div>
            <p className="mono" style={{ marginBottom: 0 }}>
              {t('view.slides', { n: office.slides.length })}
              {office.truncated ? ` · ${t('view.truncated')}` : ''}
            </p>
          </>
        );
      }
      return (
        <>
          {office.sheets.map((sheet, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 0 : 14 }}>
              <p className="card-title" style={{ marginBottom: 6 }}>
                {sheet.name}
              </p>
              <div className="preview-box flush scroll-x">
                <table className="data-table">
                  <tbody>
                    {sheet.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <p className="mono" style={{ marginBottom: 0 }}>
            {t('view.sheets', { n: office.sheets.length })}
            {office.truncated ? ` · ${t('view.truncated')}` : ''}
          </p>
        </>
      );

    case 'hex':
      return (
        <>
          <div className="preview-box">
            <pre>{preview.body}</pre>
          </div>
          <p className="mono" style={{ marginBottom: 0 }}>
            {t('view.hexNote')}
          </p>
        </>
      );

    case 'text':
    default:
      return (
        <>
          <div className="preview-box">
            <pre>{preview.body}</pre>
          </div>
          {preview.kind === 'text' && preview.truncated && <p className="notice">{t('view.truncated')}</p>}
        </>
      );
  }
}
