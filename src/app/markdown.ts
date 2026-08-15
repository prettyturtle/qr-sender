/**
 * Minimal Markdown to HTML, written rather than pulled in.
 *
 * A markdown renderer is a supply-chain surface and a bundle cost for what a
 * preview actually needs, and the security posture here is unusual: the input
 * came off a stranger's screen. So every character is escaped *first* and the
 * grammar is then applied to already-safe text — there is no path by which raw
 * input reaches the output as markup. The result is rendered inside a sandboxed
 * frame regardless, which makes this defence in depth rather than the only one.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Only http(s) and mailto survive; everything else (javascript:, data:) is dropped. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return escapeHtml(trimmed);
  return null;
}

function inline(escaped: string): string {
  let out = escaped;
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const href = safeHref(src);
    return href === null ? escapeHtml(alt) : `<img alt="${alt}" src="${href}">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const href = safeHref(url);
    return href === null ? label : `<a href="${href}" rel="noopener noreferrer nofollow">${label}</a>`;
  });
  return out;
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inFence = false;
  let fence: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = (): void => {
    if (listType !== null) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = [];
        inFence = false;
      } else {
        flushParagraph();
        closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      closeList();
      out.push('<hr>');
      continue;
    }

    const quote = /^\s*&gt;\s?(.*)$/.exec(line);
    if (quote !== null) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const want = bullet !== null ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (inFence && fence.length > 0) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  flushParagraph();
  closeList();
  return out.join('\n');
}

/** Wrap rendered markup in a self-contained document for a sandboxed frame. */
export function previewDocument(bodyHtml: string, dark: boolean): string {
  const fg = dark ? '#f2f2f5' : '#16161a';
  const bg = dark ? '#17171c' : '#ffffff';
  const dim = dark ? '#a6a6b4' : '#5f5f6b';
  const line = dark ? '#2a2a33' : '#e1e1e6';
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  body { margin:0; padding:14px; background:${bg}; color:${fg};
         font: 15px/1.6 system-ui, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
         word-break: break-word; }
  h1,h2,h3,h4,h5,h6 { line-height:1.3; margin:1.2em 0 .5em; }
  h1 { font-size:1.5em } h2 { font-size:1.3em } h3 { font-size:1.12em }
  p, ul, ol, blockquote, pre, table { margin:.7em 0 }
  a { color:#5b8cff }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background:${line}; padding:1px 5px; border-radius:4px }
  pre { background:${line}; padding:12px; border-radius:8px; overflow:auto }
  pre code { background:none; padding:0 }
  blockquote { border-left:3px solid ${line}; margin-left:0; padding-left:12px; color:${dim} }
  img, video { max-width:100%; height:auto }
  hr { border:0; border-top:1px solid ${line} }
  table { border-collapse:collapse; width:100% }
  th,td { border:1px solid ${line}; padding:6px 8px; text-align:left }
</style>
${bodyHtml}`;
}
