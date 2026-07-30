// src/plugins/platforms/wordpress/plugin.ts
import { z } from 'zod';
import type { SiteConfig } from '../../../config/sites.js';
import type { PlatformAdapter, PlatformPlugin } from '../types.js';
import { WordPressAdapter } from './index.js';
import { resolveWordPressProfile } from './html-profile.js';

/** WordPress user ids are integers. Ghost's are 24 hex chars. */
const WORDPRESS_AUTHOR_ID = /^\d+$/;

export const wordpressPlugin: PlatformPlugin = {
  id: 'wordpress',
  label: 'WordPress',

  credentialSchema: z.object({
    platform: z.literal('wordpress'),
    url: z.string().url(),
    /** Defaults to {url}/wp-json. Set when the REST API is not at the site root. */
    api_url: z.string().url().optional(),
    /** Not a secret — the login name. Stored literally in config.yaml. */
    username: z.string().min(1),
    /** Application Password. Use ${ENV_VAR}. */
    app_password: z.string().min(1),
    default_author: z.string().optional(),
  }),

  credentialFields: [
    {
      name: 'username',
      label: 'WordPress username',
      secret: false,
      example: 'editor',
      help: 'The username you log in with — not the display name, and not the email unless that is your login.',
    },
    {
      name: 'app_password',
      label: 'Application Password',
      secret: true,
      example: 'xxxx xxxx xxxx xxxx xxxx xxxx',
      help: 'WP Admin → Users → Profile → Application Passwords → enter a name → Add. Copy it with the spaces. This is NOT your login password.',
    },
  ],

  defaultApiUrl: (siteUrl) => `${siteUrl.replace(/\/+$/, '')}/wp-json`,
  makeAdapter: (site: SiteConfig) => new WordPressAdapter(site),

  /** WordPress user ids are integers. Ghost's are 24 hex chars. */
  isAuthorId: (value) => WORDPRESS_AUTHOR_ID.test(value),

  htmlProfile: (adapter: PlatformAdapter) => resolveWordPressProfile(adapter),
};
