import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../../../src/plugins/platforms/export/markdown.js';

describe('htmlToMarkdown', () => {
  it('converts headings, paragraphs, and inline formatting', () => {
    const html = '<h2>A heading</h2><p>Some <strong>bold</strong> and <em>italic</em> text.</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('## A heading');
    expect(md).toContain('Some **bold** and _italic_ text.');
  });

  it('converts a link', () => {
    const html = '<p><a href="https://example.com">a link</a></p>';
    expect(htmlToMarkdown(html)).toBe('[a link](https://example.com)');
  });

  it('converts an unordered and an ordered list, including nesting', () => {
    const html =
      '<ul><li>First<ul><li>Nested one</li><li>Nested two</li></ul></li><li>Second</li></ul>' +
      '<ol><li>Step one</li><li>Step two</li></ol>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('- First');
    expect(md).toContain('  - Nested one');
    expect(md).toContain('  - Nested two');
    expect(md).toContain('- Second');
    expect(md).toContain('1. Step one');
    expect(md).toContain('2. Step two');
  });

  it('converts a blockquote', () => {
    const html = '<blockquote><p>A quoted line.</p></blockquote>';
    expect(htmlToMarkdown(html)).toBe('> A quoted line.');
  });

  it('converts an image, as alt/src', () => {
    const html = '<p><img src="images/photo.jpg" alt="A photo"></p>';
    expect(htmlToMarkdown(html)).toBe('![A photo](images/photo.jpg)');
  });

  it('converts a figure with a figcaption', () => {
    const html = '<figure><img src="images/photo.jpg" alt="A photo"><figcaption>One line of context.</figcaption></figure>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('![A photo](images/photo.jpg)');
    expect(md).toContain('_One line of context._');
  });

  it('converts code and pre', () => {
    expect(htmlToMarkdown('<p>Use <code>npm test</code>.</p>')).toBe('Use `npm test`.');
    const pre = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(pre).toBe('```\nconst x = 1;\n```');
  });

  it('converts hr', () => {
    expect(htmlToMarkdown('<p>Before</p><hr><p>After</p>')).toBe('Before\n\n---\n\nAfter');
  });

  it('converts a table to a pipe table', () => {
    const html =
      '<table><thead><tr><th>Change</th><th>Deploy time</th></tr></thead>' +
      '<tbody><tr><td>Baseline</td><td>41 min</td></tr><tr><td>Rewrite</td><td>6 min</td></tr></tbody></table>';
    const md = htmlToMarkdown(html);
    const lines = md.split('\n');
    expect(lines[0]).toBe('| Change | Deploy time |');
    expect(lines[1]).toBe('| --- | --- |');
    expect(lines[2]).toBe('| Baseline | 41 min |');
    expect(lines[3]).toBe('| Rewrite | 6 min |');
  });

  it('unwraps an unknown tag, keeping its content', () => {
    const html = '<div><span>Structural wrapper text</span></div>';
    expect(htmlToMarkdown(html)).toBe('Structural wrapper text');
  });

  it('converts a fixture combining a table, a figure, and nested lists', () => {
    const html = [
      '<h2>Why deploys slowed down</h2>',
      '<p>We <strong>measured</strong> the pipeline before changing anything.</p>',
      '<figure><img src="images/hero.jpg" alt="Dashboard"><figcaption>The dashboard we built.</figcaption></figure>',
      '<ul><li>Queueing<ul><li>31 minutes on a bad day</li></ul></li><li>Build time</li></ul>',
      '<table><thead><tr><th>Change</th><th>Time</th></tr></thead><tbody><tr><td>Baseline</td><td>41m</td></tr></tbody></table>',
    ].join('');
    const md = htmlToMarkdown(html);
    expect(md).toContain('## Why deploys slowed down');
    expect(md).toContain('**measured**');
    expect(md).toContain('![Dashboard](images/hero.jpg)');
    expect(md).toContain('_The dashboard we built._');
    expect(md).toContain('- Queueing');
    expect(md).toContain('  - 31 minutes on a bad day');
    expect(md).toContain('| Change | Time |');
    expect(md).toContain('| Baseline | 41m |');
  });

  it('decodes HTML entities', () => {
    const md = htmlToMarkdown('<p>Fish &amp; chips &mdash; &quot;fresh&quot;</p>');
    expect(md).toContain('Fish & chips');
    expect(md).toContain('chips — "fresh"');
  });

  it('decodes typographic entities: ndash, hellip, and curly quotes', () => {
    const md = htmlToMarkdown(
      '<p>2020&ndash;2021&hellip; &lsquo;quoted&rsquo; and &ldquo;double&rdquo;</p>',
    );
    expect(md).toContain('2020–2021…');
    expect(md).toContain('‘quoted’');
    expect(md).toContain('“double”');
  });
});
