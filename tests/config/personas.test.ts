import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { getPersona, loadPersonas } from '../../src/config/personas.js';

function personaDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-personas-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const MINIMAL = `
slug: jane-doe
name: Jane Doe
role: Engineer
writing_style: Terse
tone_of_voice: Dry
platform_authors:
  personal: "abc123"
`;

describe('loadPersonas', () => {
  it('loads a persona keyed by slug', () => {
    const map = loadPersonas(personaDir({ 'jane-doe.yaml': MINIMAL }));
    expect(map.get('jane-doe')?.name).toBe('Jane Doe');
    expect(map.get('jane-doe')?.platform_authors.personal).toBe('abc123');
  });

  it('skips the _template file', () => {
    const map = loadPersonas(personaDir({ '_template.yaml': MINIMAL, 'jane-doe.yaml': MINIMAL }));
    expect(map.size).toBe(1);
    expect(map.has('jane-doe')).toBe(true);
  });

  it('defaults optional fields to empty rather than undefined', () => {
    const p = loadPersonas(personaDir({ 'jane-doe.yaml': MINIMAL })).get('jane-doe')!;
    expect(p.bias_tendency).toBe('');
    expect(p.years_of_experience).toBe(0);
    expect(p.language_written).toBe('English');
  });

  it('errors when the filename does not match the slug', () => {
    try {
      loadPersonas(personaDir({ 'wrong-name.yaml': MINIMAL }));
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('INVALID_PERSONA');
      expect(err.message).toContain('wrong-name');
    }
  });

  it('errors when a required field is missing', () => {
    try {
      loadPersonas(personaDir({ 'x.yaml': 'slug: x' }));
    } catch (e) {
      expect((e as ToolError).code).toBe('INVALID_PERSONA');
    }
  });

  it('returns an empty map for a directory with no personas', () => {
    expect(loadPersonas(personaDir({})).size).toBe(0);
  });
});

describe('getPersona', () => {
  const map = loadPersonas(personaDir({ 'jane-doe.yaml': MINIMAL }));

  it('lists valid slugs when the slug is unknown', () => {
    try {
      getPersona(map, 'nope');
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('UNKNOWN_PERSONA');
      expect(err.message).toContain('jane-doe');
    }
  });
});

describe('unknown persona fields are kept, not discarded', () => {
  // THE defect this exists for: zod strips unknown keys, so a real 51-field
  // persona file silently loaded as 27 fields and the other 24 vanished with
  // no error and no way to tell from the output.
  //
  // This goes through loadPersonas and a real file on disk deliberately. Tests
  // that build a Persona object by hand prove the brief renders extras IF they
  // arrive — which is exactly the assumption that was false, and the same
  // shape as the feature_image_id defect.
  const load = (body: string) =>
    loadPersonas(personaDir({ 'x.yaml': `slug: x\nname: X\nrole: CTO\nwriting_style: a\ntone_of_voice: b\n${body}` })).get(
      'x',
    )!;

  it('collects fields the schema does not name', () => {
    const p = load('preferred_article_length: "1200-3500 words"\nuse_of_humor: Light\n');
    expect(p.extras).toEqual({ preferred_article_length: '1200-3500 words', use_of_humor: 'Light' });
  });

  it('keeps the typed core out of extras', () => {
    const p = load('subject_expertise: Cloud\n');
    expect(p.subject_expertise).toBe('Cloud');
    expect(p.extras).toEqual({});
  });

  it('is an empty object, never undefined, when there are none', () => {
    expect(load('').extras).toEqual({});
  });

  // YAML hands back whatever was written; the brief needs one readable line.
  it('flattens a list into a readable line', () => {
    expect(load('target_audience:\n  - Founders\n  - CTOs\n').extras.target_audience).toBe('Founders, CTOs');
  });

  it('JSON-encodes a nested map rather than rendering [object Object]', () => {
    const v = load('scoring:\n  depth: high\n').extras.scoring!;
    expect(v).toContain('depth');
    expect(v).not.toContain('[object Object]');
  });

  it('stringifies a number', () => {
    expect(load('max_links: 8\n').extras.max_links).toBe('8');
  });

  // A key someone started and did not finish tells the writer nothing while
  // taking up room in the prompt.
  it('drops a key whose value is blank', () => {
    expect(load('use_of_humor: ""\nreading_level: Easy\n').extras).toEqual({ reading_level: 'Easy' });
  });
});
