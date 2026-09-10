// src/plugins/platforms/linkedin-article/plugin.ts
import { z } from 'zod';
import type { SiteConfig } from '../../../config/sites.js';
import { ExportAdapter } from '../export/adapter.js';
import type { ExportSpec } from '../export/types.js';
import type { PlatformPlugin } from '../types.js';
import { LINKEDIN_ARTICLE_HTML_PROFILE } from './html-profile.js';

const PASTE_STEPS = [
  'On LinkedIn, click Write article.',
  'Click Copy article on this page, click into the article editor, paste.',
  "Type the title into LinkedIn's own title field.",
  'Drag each image from the images folder onto its [Insert image: …] line and delete the marker.',
  "Set the cover image using LinkedIn's own cover image control — it is not part of the body.",
  "Publish the article from LinkedIn's own editor.",
] as const;

export const LINKEDIN_ARTICLE_SPEC: ExportSpec = {
  platformId: 'linkedin-article',
  label: 'LinkedIn Article',
  pasteSteps: PASTE_STEPS,
  profile: LINKEDIN_ARTICLE_HTML_PROFILE,
};

export const linkedinArticlePlugin: PlatformPlugin = {
  id: 'linkedin-article',
  label: 'LinkedIn Article',

  credentialSchema: z.object({
    platform: z.literal('linkedin-article'),
    url: z.string().url(),
    export_dir: z.string().min(1),
    default_author: z.string().optional(),
  }),

  credentialFields: [
    {
      name: 'export_dir',
      label: 'Folder for exported posts',
      secret: false,
      example: '~/Documents/byline-post',
      help: "LinkedIn has no publishing API for articles, so Byline writes each article into a folder here — text, images and a page with copy buttons — and you paste it into LinkedIn's article editor. Any folder you can write to.",
    },
  ],

  defaultApiUrl: (siteUrl) => siteUrl,

  makeAdapter: (site: SiteConfig) => new ExportAdapter(site, LINKEDIN_ARTICLE_SPEC),

  isAuthorId: () => false,

  htmlProfile: async () => LINKEDIN_ARTICLE_HTML_PROFILE,
};
