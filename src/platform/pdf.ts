/**
 * PDF rendering for browsers that will not display one inline.
 *
 * `<iframe src="blob:…">` with a PDF works on desktop browsers and Android
 * Chrome, and does not work at all on iOS Safari — the frame simply comes up
 * blank. Since iOS is a first-class receiver, "preview a PDF" cannot rely on the
 * platform viewer alone.
 *
 * `navigator.pdfViewerEnabled` is the standardised way to ask, so the native
 * viewer is used wherever it exists (better: zoom, scroll, text selection, all
 * free) and this module only loads where it does not. The import is dynamic so a
 * user who never receives a PDF never downloads the renderer.
 */

export interface RenderedPdf {
  /** Object URLs, one per rendered page. The caller owns revoking them. */
  pages: string[];
  totalPages: number;
  /** True when the document has more pages than were rendered. */
  truncated: boolean;
}

/** Enough to judge a document without spending seconds rendering all of it. */
const MAX_PAGES = 5;
/** Rendered width in CSS pixels; the preview box is never wider than this. */
const TARGET_WIDTH = 900;

export function nativePdfViewerAvailable(): boolean {
  const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
  return nav.pdfViewerEnabled === true;
}

export class PdfRenderError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PdfRenderError';
  }
}

export async function renderPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<RenderedPdf> {
  let pdfjs: typeof import('pdfjs-dist');
  try {
    const [mod, workerUrl] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.mjs?url').then((m) => m.default),
    ]);
    pdfjs = mod;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  } catch (cause) {
    throw new PdfRenderError(cause);
  }

  const pages: string[] = [];
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null;

  try {
    doc = await pdfjs.getDocument({
      // Copied because pdf.js transfers the buffer to its worker, which would
      // detach the array the rest of the viewer is still reading from.
      data: bytes.slice(),
      // The document came off a stranger's screen; never let it run script.
      isEvalSupported: false,
      // Standard fonts are not bundled — offline is a promise here, and a
      // network fetch would break it. Embedded fonts, which most PDFs carry,
      // are unaffected.
      disableFontFace: false,
    }).promise;

    const total = doc.numPages;
    const count = Math.min(total, MAX_PAGES);

    for (let i = 1; i <= count; i++) {
      if (signal?.aborted === true) break;
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, TARGET_WIDTH / base.width);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2d canvas context unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob !== null) pages.push(URL.createObjectURL(blob));
    }

    return { pages, totalPages: total, truncated: total > count };
  } catch (cause) {
    for (const url of pages) URL.revokeObjectURL(url);
    throw new PdfRenderError(cause);
  } finally {
    void doc?.destroy();
  }
}
