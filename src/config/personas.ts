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

export type Persona = z.infer<typeof PersonaSchema>;

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
    const parsed = PersonaSchema.safeParse(parse(readFileSync(join(dir, file), 'utf8')));
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
    map.set(parsed.data.slug, parsed.data);
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
