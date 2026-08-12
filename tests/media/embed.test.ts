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

describe('parseVideoUrl — XSS via searchParams URL-decoding', () => {
  // u.searchParams.get('v') returns a URL-DECODED value, unlike u.pathname
  // which stays percent-encoded — so a `watch?v=` id is the one taint path
  // where an attacker-controlled quote character can reach this file
  // un-encoded. These prove the id validator rejects it, not merely that
  // escaping happens to save it downstream.
  const injected = 'https://youtube.com/watch?v=abc%22%20onload%3D%22alert(1)';

  it('throws a ToolError with code UNSUPPORTED_VIDEO_URL for an injected watch?v= id', () => {
    try {
      parseVideoUrl(injected);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('UNSUPPORTED_VIDEO_URL');
    }
  });

  it('throws UNSUPPORTED_VIDEO_URL for the same injection via a youtu.be short link', () => {
    // youtu.be carries the id in the path, not a query param, but the
    // attacker string is passed as the path segment directly here to prove
    // the id validator — not the searchParams decoding — is what stops it.
    try {
      parseVideoUrl('https://youtu.be/abc%22%20onload%3D%22alert(1)');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('UNSUPPORTED_VIDEO_URL');
    }
  });

  it('throws UNSUPPORTED_VIDEO_URL for the same injection via a /shorts/ URL', () => {
    try {
      parseVideoUrl('https://www.youtube.com/shorts/abc%22%20onload%3D%22alert(1)');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('UNSUPPORTED_VIDEO_URL');
    }
  });

  it('rejects a Vimeo id that is not numeric on the player.vimeo.com/video/ branch', () => {
    try {
      parseVideoUrl('https://player.vimeo.com/video/76979871%22%20onload%3D%22alert(1)');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('UNSUPPORTED_VIDEO_URL');
    }
  });

  it('rejects a Bunny guid outside the allowed character class', () => {
    try {
      parseVideoUrl('https://iframe.mediadelivery.net/embed/1234/abcd"onload="alert(1)');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('UNSUPPORTED_VIDEO_URL');
    }
  });

  it('rejects a non-numeric Bunny library', () => {
    try {
      parseVideoUrl('https://iframe.mediadelivery.net/embed/12"onload="alert(1)/abcd-efgh');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('UNSUPPORTED_VIDEO_URL');
    }
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

  it('renders a ?start= URL unchanged inside the iframe src — no & to escape', () => {
    const withStart = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90');
    const html = embedHtml(withStart);
    expect(html).toBe(
      '<figure><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=90" width="560" height="315" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen title="YouTube video"></iframe></figure>',
    );
  });

  it('defence in depth — every embedUrl this module can produce lands whole in the src attribute, unbroken by any stray quote', () => {
    // For every VideoEmbed parseVideoUrl can construct (valid ids only, by
    // construction), the substring between src=" and the very next literal
    // " must equal the embed URL exactly — i.e. that first literal quote is
    // truly the closing one, not an early break caused by a stray unescaped
    // " inside the URL. Covers a bare id, a ?start= query value, Vimeo, and
    // Bunny — none of which contain HTML-significant characters, so this
    // also confirms escapeHtml is a no-op for well-formed embed URLs.
    const embeds = [
      parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90'),
      parseVideoUrl('https://vimeo.com/76979871'),
      parseVideoUrl('https://iframe.mediadelivery.net/embed/1234/abcd-efgh'),
    ];
    for (const e of embeds) {
      const html = embedHtml(e);
      const m = /src="([^"]*)"/.exec(html);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(e.embedUrl);
    }
  });

  it('escapeHtml applied to embedUrl neutralises an attribute-breakout string, proving the second layer works on its own', () => {
    // Direct proof that the escaping layer itself is correct, independent of
    // whether validation already refused the input: a VideoEmbed carrying an
    // attacker string in embedUrl (as if some future code path constructed
    // one without going through the validated parse functions) still cannot
    // break out of the src="..." attribute once run through embedHtml — the
    // raw `" onload="` breakout signature never appears, only its escaped form.
    const malicious = {
      provider: 'youtube' as const,
      embedUrl: 'https://www.youtube.com/embed/abc" onload="alert(1)',
      sourceUrl: 'https://youtube.com/watch?v=abc%22%20onload%3D%22alert(1)',
    };
    const html = embedHtml(malicious);
    expect(html).toBe(
      '<figure><iframe src="https://www.youtube.com/embed/abc&quot; onload=&quot;alert(1)" width="560" height="315" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen title="YouTube video"></iframe></figure>',
    );
    expect(html).not.toContain('" onload="alert(1)');
  });
});
