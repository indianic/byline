import { describe, expect, it } from 'vitest';
import { buildSiteBlock } from '../../src/config/site-block.js';
import { ghostPlugin } from '../../src/plugins/platforms/ghost/plugin.js';
import { wordpressPlugin } from '../../src/plugins/platforms/wordpress/plugin.js';

describe('buildSiteBlock', () => {
  it('indirects a secret field through ${ENV_VAR}', () => {
    const block = buildSiteBlock(ghostPlugin, 'https://blog.example.com', {
      admin_api_key: 'EXAMPLE_GHOST_KEY',
    });
    expect(block).toEqual({
      platform: 'ghost',
      url: 'https://blog.example.com',
      admin_api_key: '${EXAMPLE_GHOST_KEY}',
    });
  });

  it('writes a non-secret field literally, so config.yaml stays shareable', () => {
    const block = buildSiteBlock(wordpressPlugin, 'https://example.com', {
      username: 'editor',
      app_password: 'EXAMPLE_APP_PASSWORD',
    });
    expect(block.username).toBe('editor');
    expect(block.app_password).toBe('${EXAMPLE_APP_PASSWORD}');
  });

  it('strips a trailing slash from the url', () => {
    expect(buildSiteBlock(ghostPlugin, 'https://blog.example.com///', { admin_api_key: 'K' }).url).toBe(
      'https://blog.example.com',
    );
  });

  it('includes default_author only when given', () => {
    expect(buildSiteBlock(ghostPlugin, 'https://x.com', { admin_api_key: 'K' }).default_author).toBeUndefined();
    expect(
      buildSiteBlock(ghostPlugin, 'https://x.com', { admin_api_key: 'K' }, 'jane-doe').default_author,
    ).toBe('jane-doe');
  });
});
