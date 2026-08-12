import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { embedHtml, parseVideoUrl } from '../../src/media/embed.js';

describe('parseVideoUrl — YouTube', () => {
  it('normalises a watch?v= URL to the embed form — a watch URL does not work in an iframe', () => {
    const e = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(e.provider).toBe('youtube');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('normalises a youtu.be short link', () => {
    const e = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('normalises a shorts URL', () => {
    const e = parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('accepts an already-embed URL, idempotently', () => {
    const e = parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('accepts without www. and with m.', () => {
    expect(parseVideoUrl('https://youtube.com/watch?v=dQw4w9WgXcQ').embedUrl).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
    expect(parseVideoUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ').embedUrl).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  it('ignores an unrelated query string and an &t= alongside other params', () => {
    const e = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('preserves a bare-seconds t= as ?start=N', () => {
    const e = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=90');
  });

  it('preserves a duration-form t= (1m30s) as ?start=N in seconds', () => {
    const e = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=90');
  });

  it('preserves a start= param the same way as t=', () => {
    const e = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=45');
    expect(e.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=45');
  });

  it('omits ?start= entirely when no t=/start= is present', () => {
    const e = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(e.embedUrl).not.toContain('?');
  });
});

describe('parseVideoUrl — Vimeo', () => {
  it('normalises a plain vimeo.com/ID URL', () => {
    const e = parseVideoUrl('https://vimeo.com/76979871');
    expect(e.provider).toBe('vimeo');
    expect(e.embedUrl).toBe('https://player.vimeo.com/video/76979871');
  });

  it('normalises a channels URL', () => {
    const e = parseVideoUrl('https://vimeo.com/channels/staffpicks/76979871');
    expect(e.embedUrl).toBe('https://player.vimeo.com/video/76979871');
  });

  it('accepts an already-player URL', () => {
    const e = parseVideoUrl('https://player.vimeo.com/video/76979871');
    expect(e.embedUrl).toBe('https://player.vimeo.com/video/76979871');
  });
});

describe('parseVideoUrl — Bunny Stream', () => {
  it('normalises an /embed/ URL', () => {
    const e = parseVideoUrl('https://iframe.mediadelivery.net/embed/1234/abcd-efgh');
    expect(e.provider).toBe('bunny');
    expect(e.embedUrl).toBe('https://iframe.mediadelivery.net/embed/1234/abcd-efgh');
  });

  it('normalises a /play/ URL to the /embed/ form', () => {
    const e = parseVideoUrl('https://iframe.mediadelivery.net/play/1234/abcd-efgh');
    expect(e.embedUrl).toBe('https://iframe.mediadelivery.net/embed/1234/abcd-efgh');
  });
});

describe('parseVideoUrl — rejection', () => {
  it('throws a ToolError naming the URL and listing the supported providers, for an unknown host', () => {
    try {
      parseVideoUrl('https://example.com/some-video.mp4');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const te = e as ToolError;
      expect(te.message).toContain('example.com/some-video.mp4');
      expect(te.hint).toMatch(/YouTube/);
      expect(te.hint).toMatch(/Vimeo/);
      expect(te.hint).toMatch(/Bunny/);
    }
  });

  it('does NOT pass an unrecognised URL through as an escape hatch', () => {
    // Guards the "if it looks like a URL, pass it through" mistake explicitly:
    // a syntactically fine https URL on a host that is none of the three
    // supported providers must still be refused, not emitted as an iframe.
    expect(() => parseVideoUrl('https://vimeo.com.evil.example/76979871')).toThrow(ToolError);
  });

  it('throws for an unparseable string, not merely for a wrong host', () => {
    expect(() => parseVideoUrl('not a url at all')).toThrow(ToolError);
  });

  it('rejects a non-https YouTube URL rather than embedding an insecure source', () => {
    expect(() => parseVideoUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toThrow(ToolError);
  });

  it('rejects a non-https Bunny Stream URL', () => {
    expect(() => parseVideoUrl('http://iframe.mediadelivery.net/embed/1234/abcd-efgh')).toThrow(ToolError);
  });

  it('rejects a YouTube host with no recognisable video id', () => {
    expect(() => parseVideoUrl('https://www.youtube.com/')).toThrow(ToolError);
  });

  it('rejects a Bunny URL with the wrong number of path segments', () => {
    expect(() => parseVideoUrl('https://iframe.mediadelivery.net/embed/1234')).toThrow(ToolError);
  });
});

describe('embedHtml', () => {
  const yt = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ');

  it('emits the figure/iframe markup with the measured attribute set, no caption', () => {
    const html = embedHtml(yt);
    expect(html).toBe(
      '<figure><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen title="YouTube video"></iframe></figure>',
    );
  });

  it('omits <figcaption> entirely when no caption is given, rather than emitting an empty one', () => {
    const html = embedHtml(yt);
    expect(html).not.toContain('figcaption');
  });

  it('includes <figcaption> when a caption is given', () => {
    const html = embedHtml(yt, 'Watch the full talk');
    expect(html).toContain('<figcaption>Watch the full talk</figcaption>');
    expect(html).toMatch(/<\/iframe><figcaption>/);
  });

  it('uses a custom title when given, in place of the default', () => {
    const html = embedHtml(yt, undefined, 'Our product demo');
    expect(html).toContain('title="Our product demo"');
    expect(html).not.toContain('YouTube video');
  });

  it('defaults the title to "<Provider> video" per provider', () => {
    expect(embedHtml(parseVideoUrl('https://vimeo.com/76979871'))).toContain('title="Vimeo video"');
    expect(
      embedHtml(parseVideoUrl('https://iframe.mediadelivery.net/embed/1234/abcd-efgh')),
    ).toContain('title="Bunny Stream video"');
  });

  it('escapes a caption containing HTML-significant characters', () => {
    const html = embedHtml(yt, `<script>alert("x")</script> & "quoted" 'single'`);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&#39;single&#39;');
  });

  it('escapes a title containing HTML-significant characters', () => {
    const html = embedHtml(yt, undefined, `"onload=alert(1)`);
    expect(html).not.toContain('"onload=alert(1)"');
    expect(html).toContain('&quot;onload=alert(1)');
  });

  it('produces every tag on one line — no line breaks inside the markup', () => {
    const html = embedHtml(yt, 'A caption', 'A title');
    expect(html).not.toContain('\n');
  });

  it('renders the Bunny embed URL inside the iframe src', () => {
    const bunny = parseVideoUrl('https://iframe.mediadelivery.net/play/1234/abcd-efgh');
    const html = embedHtml(bunny);
    expect(html).toContain('src="https://iframe.mediadelivery.net/embed/1234/abcd-efgh"');
  });
});
