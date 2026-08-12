import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSites } from '../../src/config/sites.js';
import { ToolError } from '../../src/errors.js';
import { embedVideo, type EmbedCtx } from '../../src/tools/media-tools.js';

function ctxWith(yaml: string, env: NodeJS.ProcessEnv = {}): EmbedCtx {
  const dir = mkdtempSync(join(tmpdir(), 'bl-embed-sites-'));
  const file = join(dir, 'sites.yaml');
  writeFileSync(file, yaml);
  return { sites: loadSites(file, env) };
}

const GHOST_SITE = `
default_site: personal
sites:
  personal:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: \${GHOST_KEY}
`;

const WP_SITE = `
default_site: wp
sites:
  wp:
    platform: wordpress
    url: https://wp.example.com
    username: editor
    app_password: \${WP_PASS}
`;

describe('embedVideo (media-tools)', () => {
  it('returns provider, embed_url, and html with no site given, and no warnings', () => {
    const ctx = ctxWith(GHOST_SITE, { GHOST_KEY: 'id:secret' });
    const r = embedVideo(ctx, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(r.provider).toBe('youtube');
    expect(r.embed_url).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(r.html).toContain('<iframe');
    expect(r.warnings).toEqual([]);
  });

  it('adds no warning for a Ghost site', () => {
    const ctx = ctxWith(GHOST_SITE, { GHOST_KEY: 'id:secret' });
    const r = embedVideo(ctx, { url: 'https://youtu.be/dQw4w9WgXcQ', site: 'personal' });
    expect(r.warnings).toEqual([]);
  });

  it('adds an unfiltered_html warning for a WordPress site, naming it UNVERIFIED', () => {
    const ctx = ctxWith(WP_SITE, { WP_PASS: 'abcd efgh ijkl mnop' });
    const r = embedVideo(ctx, { url: 'https://youtu.be/dQw4w9WgXcQ', site: 'wp' });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('wp');
    expect(r.warnings[0]).toMatch(/unfiltered_html/);
    expect(r.warnings[0]).toMatch(/UNVERIFIED/);
  });

  it('throws UNKNOWN_SITE for a site that does not exist, rather than silently skipping the warning', () => {
    const ctx = ctxWith(GHOST_SITE, { GHOST_KEY: 'id:secret' });
    expect(() => embedVideo(ctx, { url: 'https://youtu.be/dQw4w9WgXcQ', site: 'nope' })).toThrow(ToolError);
  });

  it('propagates parseVideoUrl\'s ToolError for an unsupported URL', () => {
    const ctx = ctxWith(GHOST_SITE, { GHOST_KEY: 'id:secret' });
    expect(() => embedVideo(ctx, { url: 'https://example.com/video.mp4' })).toThrow(ToolError);
  });

  it('passes caption and title through to the generated html', () => {
    const ctx = ctxWith(GHOST_SITE, { GHOST_KEY: 'id:secret' });
    const r = embedVideo(ctx, {
      url: 'https://youtu.be/dQw4w9WgXcQ',
      caption: 'Full talk',
      title: 'Conference keynote',
    });
    expect(r.html).toContain('<figcaption>Full talk</figcaption>');
    expect(r.html).toContain('title="Conference keynote"');
  });
});
