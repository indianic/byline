/**
 * `renderHandoffPage` — pure, no I/O. Produces the self-contained `index.html`
 * every export platform writes alongside `article.html`/`article.md`: a page
 * a human opens in a browser, reads, and uses to paste the article into
 * Medium/Substack/LinkedIn's own editor by hand, because none of those
 * platforms has a publishing API `ExportAdapter` can call instead.
 *
 * Self-contained on purpose — inline CSS and JS, no CDN, no external request
 * of any kind — because this file has to keep working from a folder on a
 * user's disk with no server behind it and no guarantee of network access.
 */

export interface HandoffInput {
  label: string;
  title: string;
  subtitle?: string;
  tags: string[];
  /** The full article HTML, with every image `src` already pointing at `images/<file>`. */
  articleHtml: string;
  articleMarkdown: string;
  images: Array<{ file: string; alt: string; role: 'hero' | 'inline' }>;
  /** Numbered, platform-specific paste steps. */
  pasteSteps: readonly string[];
  meta: Record<string, string>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Every `<img>`/`<figure>` replaced by the literal instruction to insert that
 * image by hand — because a `file://` image reference does not survive a
 * paste into any web editor, so the writer has to drag the file in from the
 * `images/` folder themselves. This is what the "Copy article" button copies;
 * the live preview below it shows the real images instead, so the writer can
 * still see what the finished article looks like.
 */
// Deliberately `[Insert image: images/{file}]`, matching the literal marker
// text `renderImageRow` prints under each thumbnail below — not the brief's
// bare `{file}` placeholder syntax. The writer is matching this string by
// eye against the copied article to find where each image goes, so the two
// have to read identically; a bare filename here would silently stop
// matching what the image row says to look for.
function markImagesForInsertion(html: string): string {
  let out = html.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (block) => {
    const src = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(block)?.[1] ?? '';
    return `<p><em>[Insert image: ${escapeHtml(src)}]</em></p>`;
  });
  out = out.replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_m, src: string) => {
    return `<p><em>[Insert image: ${escapeHtml(src)}]</em></p>`;
  });
  return out;
}

/** UTF-8-safe base64, so a persona's em dashes and non-ASCII names survive the `atob()` round trip in the browser. */
function toBase64Utf8(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * `JSON.stringify`, then escape every `<` — an HTML parser ends a `<script>`
 * element at the first literal `</script`, even inside a quoted JS string, so
 * a title or tag containing that text would truncate the page's own script.
 * `<` is indistinguishable from `<` once JavaScript parses the string
 * back, so nothing about the value changes at runtime.
 */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const PAGE_STYLE = `
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b7280;
  --border: #e2e8f0;
  --accent: #1e3a5f;
  --accent-fg: #ffffff;
  --card: #f8fafc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a;
    --fg: #e2e8f0;
    --muted: #94a3b8;
    --border: #334155;
    --accent: #3b82f6;
    --accent-fg: #0f172a;
    --card: #1e293b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
main { max-width: 760px; margin: 0 auto; }
h1 { font-size: 1.6em; margin: 0 0 4px; }
.subtitle { color: var(--muted); margin: 0 0 12px; }
.tags { color: var(--muted); font-size: 0.9em; }
section { margin: 28px 0; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
button {
  font: inherit;
  padding: 10px 16px;
  margin: 4px 6px 4px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-fg);
  cursor: pointer;
}
button.secondary { background: transparent; color: var(--fg); }
.status { margin-left: 8px; font-size: 0.85em; color: var(--muted); }
.image-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.image-item { max-width: 220px; }
.image-item img { max-width: 100%; border-radius: 6px; display: block; margin-bottom: 6px; }
.image-item a { word-break: break-all; }
ol.paste-steps li { margin-bottom: 8px; }
article img { max-width: 100%; border-radius: 8px; }
`;

/** One row per image: a download link, the exact insertion marker text, and a thumbnail. */
function renderImageRow(images: HandoffInput['images']): string {
  if (images.length === 0) {
    return '<p>No images in this article.</p>';
  }
  return `<div class="image-row">${images
    .map(
      (img) => `<div class="image-item">
        <img src="images/${escapeHtml(img.file)}" alt="${escapeHtml(img.alt)}">
        <div><a href="images/${escapeHtml(img.file)}" download="${escapeHtml(img.file)}">${escapeHtml(img.file)}</a> (${img.role})</div>
        <div>Insert this where the article says [Insert image: images/${escapeHtml(img.file)}]</div>
      </div>`,
    )
    .join('\n')}</div>`;
}

export function renderHandoffPage(input: HandoffInput): string {
  const copyableHtml = markImagesForInsertion(input.articleHtml);
  const htmlB64 = toBase64Utf8(copyableHtml);
  const mdB64 = toBase64Utf8(input.articleMarkdown);
  const tagsText = input.tags.join(', ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} — ${escapeHtml(input.label)} hand-off</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(input.title)}</h1>
  ${input.subtitle ? `<p class="subtitle">${escapeHtml(input.subtitle)}</p>` : ''}
  <p class="tags">Tags: ${escapeHtml(tagsText || '(none)')}</p>

  <section id="actions">
    <h2>Copy</h2>
    <button id="copy-article">Copy article</button>
    <button id="copy-markdown">Copy Markdown</button>
    <span id="copy-article-status" class="status"></span>
    <div>
      <button id="copy-title" class="secondary">Copy title</button>
      <button id="copy-subtitle" class="secondary">Copy subtitle</button>
      <button id="copy-tags" class="secondary">Copy tags</button>
      <span id="copy-fields-status" class="status"></span>
    </div>
  </section>

  <section id="images">
    <h2>Images</h2>
    ${renderImageRow(input.images)}
  </section>

  <section id="paste-steps">
    <h2>How to publish on ${escapeHtml(input.label)}</h2>
    <ol class="paste-steps">
      ${input.pasteSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('\n      ')}
    </ol>
  </section>

  <section id="preview">
    <h2>Preview</h2>
    <article>${input.articleHtml}</article>
  </section>
</main>

<div id="copy-fallback" contenteditable="true" style="position:fixed;top:-9999px;left:-9999px;" aria-hidden="true"></div>

<script>
(function () {
  var TITLE = ${jsString(input.title)};
  var SUBTITLE = ${jsString(input.subtitle ?? '')};
  var TAGS = ${jsString(tagsText)};
  var ARTICLE_HTML_B64 = ${jsString(htmlB64)};
  var ARTICLE_MD_B64 = ${jsString(mdB64)};

  function b64ToUtf8(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function setStatus(elId, ok) {
    var el = document.getElementById(elId);
    if (el) el.textContent = ok ? 'Copied' : 'Copy failed — select and copy manually';
  }

  function fallbackCopyHtml(html) {
    var el = document.getElementById('copy-fallback');
    el.innerHTML = html;
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    el.innerHTML = '';
    return ok;
  }

  function fallbackCopyText(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyRich(html, text) {
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        var item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        });
        return navigator.clipboard.write([item]).then(function () { return true; }).catch(function () {
          return fallbackCopyHtml(html);
        });
      } catch (e) {
        return Promise.resolve(fallbackCopyHtml(html));
      }
    }
    return Promise.resolve(fallbackCopyHtml(html));
  }

  function copyPlain(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
        return fallbackCopyText(text);
      });
    }
    return Promise.resolve(fallbackCopyText(text));
  }

  document.getElementById('copy-article').addEventListener('click', function () {
    var html = b64ToUtf8(ARTICLE_HTML_B64);
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var text = tmp.innerText || tmp.textContent || '';
    copyRich(html, text).then(function (ok) { setStatus('copy-article-status', ok); });
  });

  document.getElementById('copy-markdown').addEventListener('click', function () {
    var md = b64ToUtf8(ARTICLE_MD_B64);
    copyPlain(md).then(function (ok) { setStatus('copy-article-status', ok); });
  });

  document.getElementById('copy-title').addEventListener('click', function () {
    copyPlain(TITLE).then(function (ok) { setStatus('copy-fields-status', ok); });
  });
  document.getElementById('copy-subtitle').addEventListener('click', function () {
    copyPlain(SUBTITLE).then(function (ok) { setStatus('copy-fields-status', ok); });
  });
  document.getElementById('copy-tags').addEventListener('click', function () {
    copyPlain(TAGS).then(function (ok) { setStatus('copy-fields-status', ok); });
  });
})();
</script>
</body>
</html>
`;
}
