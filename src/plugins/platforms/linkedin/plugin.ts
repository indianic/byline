// src/plugins/platforms/linkedin/plugin.ts
import { z } from 'zod';
import type { SiteConfig } from '../../../config/sites.js';
import type { PlatformPlugin } from '../types.js';
import { LinkedInAdapter } from './index.js';
import { LINKEDIN_POST_PROFILE } from './html-profile.js';

/** `urn:li:person:...` or `urn:li:organization:...`. Also matches the literal `me` placeholder. */
const AUTHOR_URN = /^urn:li:(person|organization):[A-Za-z0-9_-]+$/;

export const linkedinPlugin: PlatformPlugin = {
  id: 'linkedin',
  label: 'LinkedIn',

  credentialSchema: z.object({
    platform: z.literal('linkedin'),
    /** Profile or company page URL — shown in list_sites, never called. */
    url: z.string().url(),
    access_token: z.string().min(1),
    author_urn: z.string().regex(AUTHOR_URN),
    /** `YYYYMM`. Overrides `LINKEDIN_VERSION` when set. */
    api_version: z.string().regex(/^\d{6}$/).optional(),
    default_author: z.string().optional(),
  }),

  credentialFields: [
    {
      name: 'access_token',
      label: 'LinkedIn access token',
      secret: true,
      example: 'AQV…',
      help: 'developer.linkedin.com → your app → Auth → OAuth 2.0 tools → generate a token with the scopes openid, profile, w_member_social. Tokens last about 60 days; repeat when it expires. Posting as an organisation needs w_organization_social, which LinkedIn grants only after Community Management API approval.',
    },
    {
      name: 'author_urn',
      label: 'Author URN',
      secret: false,
      example: 'urn:li:person:AbC123 or urn:li:organization:12345',
      help: 'Who the post is from. Leave the placeholder, finish setup, then run list_authors against this site: it prints your person URN and any organisation you administer.',
    },
  ],

  // Nothing on the credentialed site's own URL is ever called — the API lives
  // at a fixed host regardless of what `url` (the profile/company page shown
  // in list_sites) happens to be.
  defaultApiUrl: () => 'https://api.linkedin.com',

  makeAdapter: (site: SiteConfig) => new LinkedInAdapter(site),

  // LinkedIn's per-post `author` is not exposed through this layer — the
  // site's configured `author_urn` is always who the post is from (resolving
  // the literal `me` at request time; see `linkedin/index.ts`). A raw id
  // typed into create_post's `author` field would have nowhere to go, so
  // this always reports false, the same as the export platforms.
  isAuthorId: () => false,

  htmlProfile: async () => LINKEDIN_POST_PROFILE,
};
