/**
 * "Share this app" dialog: the URL, a copy button, and a QR of it.
 *
 * This is the one QR in the product that a *stranger's* camera app has to read,
 * with no help from us — so it is deliberately conservative where the transfer
 * symbols are not. Dark modules on white, error correction at M rather than L,
 * and the version left to the encoder. Inverted symbols (light on dark) look
 * better and are read by many scanners, but "many" is the wrong bar for the one
 * code whose whole job is onboarding someone who does not have the app yet.
 *
 * Built on `<dialog>` for the modal semantics that come with it: focus is
 * trapped, Escape closes, and the rest of the page is inert.
 */

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { moduleScale, paintQr, symbolSide } from '../../platform/qrRender.js';
import { useT } from '../i18n.js';
import { Modal } from './Modal.js';

/** Module colour. Deep enough to clear the contrast floor against white by a wide margin. */
const SHARE_DARK = '#1b3a8f';
const QR_CSS_SIZE = 232;

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
}

function shareUrl(): string {
  const loc = globalThis.location;
  if (loc === undefined) return '';
  // No hash: a shared link should land on the app, not on whichever tab the
  // sharer happened to have open.
  return `${loc.origin}${loc.pathname}`;
}

export function ShareDialog({ open, onClose }: ShareDialogProps): JSX.Element | null {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const url = shareUrl();

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (canvas === null || url === '') return;

    // Version is left to the encoder: a short URL needs a small symbol, and a
    // small symbol means large modules, which is what makes it scan instantly.
    const sym = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const qr = { modules: sym.modules.size, data: sym.modules.data as unknown as Uint8Array };

    const dpr = globalThis.devicePixelRatio || 1;
    const scale = moduleScale(qr.modules, Math.floor(QR_CSS_SIZE * dpr));
    const side = symbolSide(qr.modules, scale);
    canvas.width = side;
    canvas.height = side;
    canvas.style.width = `${side / dpr}px`;
    canvas.style.height = `${side / dpr}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) return;
    paintQr(ctx, qr, { scale, dark: SHARE_DARK, light: '#ffffff', rounded: true });
  }, [open, url]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard denied: the field is selectable, so there is still a way.
    }
  }

  async function nativeShare(): Promise<void> {
    try {
      await navigator.share({ title: t('app.name'), text: t('app.tagline'), url });
    } catch {
      // Cancelled or unsupported — the copy button covers it.
    }
  }

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <Modal open={open} onClose={onClose} title={t('share.title')} className="share-dialog">
      <div className="share-url">
        <input
          type="text"
          readOnly
          value={url}
          aria-label={t('share.link')}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          {copied ? t('view.copied') : t('view.copy')}
        </button>
      </div>

      <div className="share-qr">
        <canvas ref={canvasRef} role="img" aria-label={t('share.qrAlt')} />
      </div>

      <p className="share-note">{t('share.hint')}</p>

      {canNativeShare && (
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn" onClick={() => void nativeShare()}>
            {t('share.native')}
          </button>
        </div>
      )}
    </Modal>
  );
}
