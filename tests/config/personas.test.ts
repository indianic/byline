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
