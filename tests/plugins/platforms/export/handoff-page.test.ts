import { describe, expect, it } from 'vitest';
import { renderHandoffPage, type HandoffInput } from '../../../../src/plugins/platforms/export/handoff-page.js';

const INPUT: HandoffInput = {
  label: 'Medium',
  title: 'Legacy modernisation in the Gulf',
  subtitle: 'What actually breaks first',
  tags: ['cloud', 'legacy'],
  articleHtml:
    '<p>Opening paragraph.</p>' +
    '<figure><img src="images/hero.jpg" alt="A team at work"><figcaption>The team, mid-migration.</figcaption></figure>' +
    '<p>Closing paragraph with <img src="images/inline1.jpg" alt="A dashboard"> inline.</p>',
  articleMarkdown: '## Heading\n\nBody text.',
  images: [
    { file: 'hero.jpg', alt: 'A team at work', role: 'hero' },
    { file: 'inline1.jpg', alt: 'A dashboard', role: 'inline' },
  ],
  pasteSteps: ['Open medium.com/new-story.', 'Paste the article.', 'Add the tags.'],
  meta: { status: 'draft' },
};

describe('renderHandoffPage', () => {
  const page = renderHandoffPage(INPUT);

  it('is a complete, self-contained HTML document with no external resources', () => {
    expect(page).toMatch(/^<!doctype html>/i);
    expect(page).toContain('<html');
    expect(page).not.toMatch(/https?:\/\/(?!example)/i); // no CDN / external fetch
    expect(page).not.toContain('<link ');
  });

  it('has a viewport meta tag and dark-mode support', () => {
    expect(page).toContain('name="viewport"');
    expect(page).toContain('prefers-color-scheme: dark');
  });

  it('shows the title, subtitle, and tags', () => {
    expect(page).toContain('Legacy modernisation in the Gulf');
    expect(page).toContain('What actually breaks first');
    expect(page).toContain('cloud, legacy');
  });

  it('has the three copy actions: article, markdown, and per-field', () => {
    expect(page).toContain('id="copy-article"');
    expect(page).toContain('Copy article');
    expect(page).toContain('id="copy-markdown"');
    expect(page).toContain('Copy Markdown');
    expect(page).toContain('id="copy-title"');
    expect(page).toContain('id="copy-subtitle"');
    expect(page).toContain('id="copy-tags"');
  });

  it('wires the copy button to navigator.clipboard.write with a ClipboardItem, and an execCommand fallback', () => {
    expect(page).toContain('navigator.clipboard.write');
    expect(page).toContain('new ClipboardItem');
    expect(page).toContain("execCommand('copy')");
    expect(page).toContain('contenteditable="true"');
  });

  it('shows a download link and the insertion instruction for each image', () => {
    expect(page).toContain('download="hero.jpg"');
    expect(page).toContain('Insert this where the article says [Insert image: images/hero.jpg]');
    expect(page).toContain('download="inline1.jpg"');
    expect(page).toContain('Insert this where the article says [Insert image: images/inline1.jpg]');
  });

  it('lists the platform-specific paste steps, numbered', () => {
    expect(page).toContain('Open medium.com/new-story.');
    expect(page).toContain('Add the tags.');
    expect(page).toMatch(/<ol[^>]*class="paste-steps"/);
  });

  it('shows real images in the rendered preview', () => {
    const previewIdx = page.indexOf('id="preview"');
    const preview = page.slice(previewIdx);
    expect(preview).toContain('<img src="images/hero.jpg"');
    expect(preview).toContain('<img src="images/inline1.jpg"');
  });

  it('the copyable HTML payload has no <img> tags — only insertion markers', () => {
    // The copyable payload is embedded as base64 so it survives verbatim
    // through the page; decode it the same way the browser does.
    const m = /var ARTICLE_HTML_B64 = "([^"]+)"/.exec(page);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, 'base64').toString('utf8');
    expect(decoded).not.toContain('<img');
    expect(decoded).not.toContain('<figure');
    expect(decoded).toContain('[Insert image: images/hero.jpg]');
    expect(decoded).toContain('[Insert image: images/inline1.jpg]');
  });

  it('the copyable markdown payload matches what was passed in', () => {
    const m = /var ARTICLE_MD_B64 = "([^"]+)"/.exec(page);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, 'base64').toString('utf8');
    expect(decoded).toBe(INPUT.articleMarkdown);
  });

  it('is usable at phone width — no min-width wider than a small viewport', () => {
    expect(page).not.toMatch(/min-width:\s*\d{3,}px/);
  });

  it('renders without a subtitle when none is given', () => {
    const noSubtitle = renderHandoffPage({ ...INPUT, subtitle: undefined });
    expect(noSubtitle).not.toContain('undefined');
  });

  it('escapes HTML-significant characters in the title', () => {
    const dangerous = renderHandoffPage({ ...INPUT, title: '<script>alert(1)</script>' });
    expect(dangerous).not.toContain('<script>alert(1)</script>');
    expect(dangerous).toContain('&lt;script&gt;');
  });
});
