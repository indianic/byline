import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ToolError } from '../errors.js';

const str = z.string().default('');

const PersonaSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  gender: str,
  role: z.string().min(1),
  country: str,
  state: str,
  years_of_experience: z.number().default(0),
  language_written: z.string().default('English'),

  writing_style: z.string().min(1),
  tone_of_voice: z.string().min(1),
  communication_style: str,
  storytelling_style: str,
  sentence_structure: str,
  local_journalistic_style: str,
  cultural_influence: str,

  description: str,
  subject_expertise: str,
  industry_specialization: str,
  beats_or_focus_areas: str,

  personality_traits: str,
  political_leaning: str,
  bias_tendency: str,
  risk_tolerance_in_opinions: str,
  influence_level: str,
  research_methodology: str,

  persona_specific_instructions_for_ai: str,

  platform_authors: z.record(z.string(), z.string()).default({}),
});

/**
 * Every field above is typed because something BRANCHES on it — `slug` and
 * `platform_authors` resolve a byline, `language_written` sets the output
 * language, `years_of_experience` is interpolated as a number.
 *
 * Everything else a person might want to say about how they write is free
 * text that only ever reaches the writing brief. Those do not need a schema;
 * they need to arrive. Zod strips unknown keys by default, so a persona file
 * carrying 51 fields silently became 27 and the other 24 were discarded with
 * no error, no warning, and no way to tell from the output. Adding a field and
 * having it quietly ignored is precisely the silent failure this project's
 * rules forbid.
 *
 * `extras` is where they go. Anything not named above is kept, in file order,
 * and rendered into the brief. Values are stringified because YAML will
 * cheerfully hand back a list, a number or a nested map, and the brief needs a
 * line of text — a nested map is JSON-encoded rather than becoming
 * `[object Object]`.
 */
export type Persona = z.infer<typeof PersonaSchema> & {
  /** Fields the schema does not name, preserved verbatim for the brief. */
  extras: Record<string, string>;
};

/** YAML gives back whatever was written; the brief needs one readable line. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

/**
 * Split a parsed persona file into the typed core and everything else.
 *
 * Empty extras are dropped: a key present but blank is a field someone started
 * and did not finish, and putting `use_of_humor:` with nothing after it into
 * the brief tells the writer nothing while taking up space in the prompt.
 */
export function splitExtras(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const known = new Set(Object.keys(PersonaSchema.shape));
  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (known.has(key)) continue;
    const text = asText(value);
    if (text) extras[key] = text;
  }
  return extras;
}

export function loadPersonas(dir = 'personas'): Map<string, Persona> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'));
  } catch {
    throw new ToolError({
      api: 'config',
      code: 'CONFIG_NOT_FOUND',
      message: `Cannot read persona directory at ${dir}`,
    });
  }

  const map = new Map<string, Persona>();
  for (const file of files) {
    const expectedSlug = basename(file).replace(/\.ya?ml$/, '');
    const raw = parse(readFileSync(join(dir, file), 'utf8'));
    const parsed = PersonaSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ToolError({
        api: 'config',
        code: 'INVALID_PERSONA',
        message: `personas/${file} is invalid: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      });
    }
    if (parsed.data.slug !== expectedSlug) {
      throw new ToolError({
        api: 'config',
        code: 'INVALID_PERSONA',
        message: `personas/${file} declares slug "${parsed.data.slug}" but the filename says "${expectedSlug}"`,
        hint: 'Rename the file or fix the slug so they match',
      });
    }
    map.set(parsed.data.slug, { ...parsed.data, extras: splitExtras(raw) });
  }
  return map;
}

export function getPersona(map: Map<string, Persona>, slug: string): Persona {
  const p = map.get(slug);
  if (!p) {
    throw new ToolError({
      api: 'config',
      code: 'UNKNOWN_PERSONA',
      message: `No persona "${slug}". Available: ${[...map.keys()].join(', ') || '(none)'}`,
    });
  }
  return p;
}
