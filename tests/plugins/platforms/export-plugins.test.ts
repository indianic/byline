import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBrief } from '../../../src/craft/brief.js';
import type { Persona } from '../../../src/config/personas.js';
import { loadSites } from '../../../src/config/sites.js';
import { LINKEDIN_ARTICLE_SPEC } from '../../../src/plugins/platforms/linkedin-article/plugin.js';
import { MEDIUM_SPEC } from '../../../src/plugins/platforms/medium/plugin.js';
import { PLATFORM_IDS, getPlugin } from '../../../src/plugins/registry.js';
import { SUBSTACK_SPEC } from '../../../src/plugins/platforms/substack/plugin.js';

function fixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-export-sites-'));
  const file = join(dir, 'sites.yaml');
  writeFileSync(file, yaml);
  return file;
}

describe('every registered plugin', () => {
  it('has at least one credentialField and a non-empty label', () => {
    for (const id of PLATFORM_IDS) {
      const plugin = getPlugin(id);
      expect(plugin.credentialFields.length).toBeGreaterThanOrEqual(1);
      expect(plugin.label.trim()).not.toBe('');
    }
  });
});

describe('loadSites with an export-platform site', () => {
  it('resolves a literal export_dir and leaves unavailable undefined', () => {
    const yaml = `
sites:
  myblog-medium:
    platform: medium
    url: https://medium.com/@me
    export_dir: ~/Documents/byline-post
`;
    const cfg = loadSites(fixture(yaml), {});
    const site = cfg.sites['myblog-medium'];
    expect(site).toBeDefined();
    expect(site?.credentials.export_dir).toBe('~/Documents/byline-post');
    expect(site?.unavailable).toBeUndefined();
  });
});

const PERSONA = {
  slug: 'jane-doe',
  name: 'Jane Doe',
  gender: 'female',
  role: 'CTO',
  country: 'India',
  state: 'Gujarat',
  years_of_experience: 18,
  language_written: 'English',
  writing_style: 'Analytical',
  tone_of_voice: 'Dry',
  communication_style: 'Clear',
  storytelling_style: 'Narrative',
  sentence_structure: 'Varied',
  local_journalistic_style: '',
  cultural_influence: 'Indian IT',
  description: 'Delivery',
  subject_expertise: 'Cloud',
  industry_specialization: 'SaaS',
  beats_or_focus_areas: 'AI',
  personality_traits: 'Blunt',
  political_leaning: 'neutral',
  bias_tendency: 'Anti-hype',
  risk_tolerance_in_opinions: 'high',
  influence_level: 'senior',
  research_methodology: 'Primary data',
  persona_specific_instructions_for_ai: 'Name the real trade-off.',
  platform_authors: {},
} satisfies Persona;

describe('the writing brief for each export profile', () => {
  const SPECS = [MEDIUM_SPEC, SUBSTACK_SPEC, LINKEDIN_ARTICLE_SPEC];

  it('renders the exact UNVERIFIED HTML RULES header for every export profile', () => {
    for (const spec of SPECS) {
      const { brief } = buildBrief({
        persona: PERSONA,
        topic: 'AI agents in fintech',
        mode: 'blog',
        profile: spec.profile,
        seed: 3,
      });
      expect(brief).toContain(
        `=== HTML RULES (${spec.label.toUpperCase()} — STRICT, UNVERIFIED — REASONED FROM DOCUMENTED PLATFORM BEHAVIOUR, NOT MEASURED) ===`,
      );
    }
  });

  it('renders SUMMARY BLOCK — Quote and No tables for every export profile', () => {
    for (const spec of SPECS) {
      const { brief } = buildBrief({
        persona: PERSONA,
        topic: 'AI agents in fintech',
        mode: 'blog',
        profile: spec.profile,
        seed: 3,
      });
      expect(brief).toContain('SUMMARY BLOCK — Quote');
      expect(brief).toContain('No tables');
      expect(brief).not.toContain('TABLE THEME');
    }
  });
});
