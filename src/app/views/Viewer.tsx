/**
 * Result viewer for a completed receive.
 *
 * The decoded bytes are already in memory, so everything here is a local blob:
 * no fetch, no object store, no server. The single discipline that matters is
 * that every `createObjectURL` has a matching `revokeObjectURL` in an effect
 * cleanup — a 10MB blob leaked per transfer is a real cost on a phone.
 */

import { useEffect, useMemo, useState } from 'react';
import { sanitizeFilename, sanitizeMime } from '../../core/filename.js';
import { formatBytes } from '../estimate.js';
import { useT, type MessageKey } from '../i18n.js';

export interface ViewerProps {
  name: string;
  mime: string;
  data: Uint8Array;
  integrity: 'verified' | 'mismatch' | 'unknown';
  onReset: () => void;
}

/** Beyond this the `<pre>` stops being a preview and starts being a jank source. */
const TEXT_PREVIEW_LIMIT = 64 * 1024;

const FALLBACK_MIME = 'application/octet-stream';

function isJsonLike(mime: string): boolean {
  return mime === 'application/json' || mime.endsWith('+json');
}

function isTextual(mime: string): boolean {
  return mime.startsWith('text/') || isJsonLike(mime) || mime === 'application/xml' || mime.endsWith('+xml');
}

interface TextPreview {
  body: string;
  truncated: boolean;
}

export function Viewer({ name, mime, data, integrity, onReset }: ViewerProps): JSX.Element {
  const t = useT();
  // Both are sender-controlled. Clean them once, at the boundary where they are
  // shown and used, rather than trusting them through the render tree.
  const safeName = useMemo(() => sanitizeFilename(name), [name]);
  const safeMime = useMemo(() => sanitizeMime(mime), [mime]);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The MIME type arrives from the sender and is therefore untrusted. A blob URL
  // is same-origin, so a blob typed `text/html` that the user opens in a new tab
  // would run script with access to this origin's storage. Two defences:
  // downloads are always typed `application/octet-stream`, and the preview blob
  // is only created for an allowlist of types the browser will not script.
  //
  // PDF is deliberately absent. Rendering it needs an iframe, and an iframe
  // safe enough to host untrusted content (`sandbox` without
  // `allow-same-origin`) runs in an opaque origin that cannot load a blob URL
  // this document created — so the frame comes up blank in several browsers.
  // A missing preview with a working download beats a silently empty box.
  const previewMime = useMemo(() => {
    // SVG is an image that can carry script; the textual branch renders it as
    // source instead, which is both safer and more useful.
    if (safeMime.startsWith('image/') && safeMime !== 'image/svg+xml') return safeMime;
    return null;
  }, [safeMime]);

  // Created inside the effect rather than in a memo so a StrictMode double-mount
  // hands out a fresh URL instead of reusing one it has already revoked.
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: FALLBACK_MIME }));
    setDownloadUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [data]);

  useEffect(() => {
    if (previewMime === null) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: previewMime }));
    setPreviewUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [data, previewMime]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const textual = isTextual(safeMime);

  const preview = useMemo<TextPreview | null>(() => {
    if (!textual) return null;
    const truncated = data.byteLength > TEXT_PREVIEW_LIMIT;
    const slice = truncated ? data.subarray(0, TEXT_PREVIEW_LIMIT) : data;
    let body = new TextDecoder().decode(slice);
    // Pretty-printing a truncated document would only ever throw, so don't try.
    if (!truncated && isJsonLike(safeMime)) {
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* not valid JSON after all — show it verbatim */
      }
    }
    return { body, truncated };
  }, [data, safeMime, textual]);

  const integrityKey: MessageKey | null =
    integrity === 'verified' ? 'recv.verified' : integrity === 'mismatch' ? 'recv.mismatch' : null;
  const integrityClass = integrity === 'verified' ? 'badge ok' : 'badge danger';

  async function copy(): Promise<void> {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(data));
      setCopied(true);
    } catch {
      /* clipboard denied — the download button is still there */
    }
  }

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
            <dd style={{ fontSize: 13, wordBreak: 'break-all' }}>{safeMime}</dd>
          </div>
          {integrityKey !== null && (
            <div className="stat">
              <dt>{t('view.integrity')}</dt>
              <dd>
                <span className={integrityClass}>{t(integrityKey)}</span>
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="card">
        <h2 className="card-title">{t('view.preview')}</h2>
        <div className="preview-box">
          {preview !== null ? (
            <pre>{preview.body}</pre>
          ) : previewUrl !== null ? (
            <img src={previewUrl} alt={safeName} />
          ) : (
            <p className="notice">{t('view.noPreview')}</p>
          )}
        </div>
        {preview?.truncated === true && <p className="notice">{t('view.truncated')}</p>}
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
