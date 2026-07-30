import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { clackPrompter, type Prompter } from './credentials.js';

/**
 * The five questions `init` asks about the author persona.
 *
 * Deliberately five, no more: `name`, `role`, and the combined
 * `styleAndTone` map onto the ONLY fields `PersonaSchema` requires beyond
 * `slug` (`name`, `role`, `writing_style`, `tone_of_voice` — `writing_style`
 * and `tone_of_voice` share one answer, since asking them back-to-back
 * produced two near-identical questions). `yearsOfExperience` and
 * `subjectExpertise` both have real defaults in the schema, so skipping
 * either is safe; they are asked anyway because `brief.ts` reads both
 * directly into the article's opening line. Everything else stays empty and
 * is left for manual editing — see the template path `init` always prints.
 */
export interface PersonaAnswers {
  name: string;
  role: string;
  styleAndTone: string;
  yearsOfExperience: number;
  subjectExpertise: string;
}

/**
 * A persona's filename must equal its `slug` field — `loadPersonas` enforces
 * this and throws for the WHOLE directory otherwise, not just this file — so
 * the name someone types has to become a safe, deterministic filename stem.
 */
export function slugifyPersonaName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'author';
}

/**
 * Walk the five questions. Returns null as soon as a REQUIRED one (name,
 * role, style-and-tone) is skipped, and does not ask the rest — a persona
 * file missing any of those fails `PersonaSchema`, and `loadPersonas` throws
 * for every persona in the directory when even one file fails to parse, so a
 * half-answered persona must never be written at all. This is exactly the
 * discipline `collectCredentialValues` already applies to site credentials,
 * for the same reason: a value that "looks entered" but is not complete is
 * worse than not being written.
 */
export async function promptPersonaAnswers(p: Prompter = clackPrompter): Promise<PersonaAnswers | null> {
  // Every prompt in this codebase supplies a `placeholder` — see promptSlug,
  // promptUrl, collectCredentialValues — and these five did not. That was not
  // just an inconsistency: @clack's text() renders the literal string
  // "undefined" as the confirmed value when Enter is pressed on empty input
  // with no placeholder set, which is real and was seen live in a terminal,
  // not guessed at.
  const name = await p.text({
    message: 'Your name — used as the byline (Enter nothing to skip)',
    placeholder: 'Alex Chen',
  });
  if (!name) return null;

  const role = await p.text({
    message: 'Your role or title (Enter nothing to skip)',
    placeholder: 'Senior Engineer, Freelance Journalist',
  });
  if (!role) return null;

  const styleAndTone = await p.text({
    message: 'Your writing style and tone, in a few words (Enter nothing to skip)',
    placeholder: 'Analytical, direct, confident',
  });
  if (!styleAndTone) return null;

  const yearsRaw = await p.text({ message: 'Years of experience (Enter nothing to skip)', placeholder: '10' });
  const parsedYears = yearsRaw ? Number.parseInt(yearsRaw, 10) : NaN;
  const yearsOfExperience = Number.isFinite(parsedYears) && parsedYears > 0 ? parsedYears : 0;

  const subjectExpertise = await p.text({
    message: 'Your main subject expertise (Enter nothing to skip)',
    placeholder: 'cloud architecture, personal finance',
  });

  return { name, role, styleAndTone, yearsOfExperience, subjectExpertise: subjectExpertise ?? '' };
}

/**
 * Every field `PersonaSchema` declares, built from the five answers plus its
 * defaults. Kept as a plain record (not the `Persona` type) so this module
 * does not need to import `config/personas.ts`'s zod schema just to shape an
 * object — `writePersonaFile`'s caller can round-trip it through the real
 * loader to prove it validates, which is the test that actually matters.
 */
export function buildPersonaRecord(answers: PersonaAnswers): Record<string, unknown> {
  return {
    slug: slugifyPersonaName(answers.name),
    name: answers.name,
    gender: '',
    role: answers.role,
    country: '',
    state: '',
    years_of_experience: answers.yearsOfExperience,
    language_written: 'English',

    writing_style: answers.styleAndTone,
    tone_of_voice: answers.styleAndTone,
    communication_style: '',
    storytelling_style: '',
    sentence_structure: '',
    local_journalistic_style: '',
    cultural_influence: '',

    description: '',
    subject_expertise: answers.subjectExpertise,
    industry_specialization: '',
    beats_or_focus_areas: '',

    personality_traits: '',
    political_leaning: 'neutral',
    bias_tendency: '',
    risk_tolerance_in_opinions: 'medium',
    influence_level: '',
    research_methodology: '',

    persona_specific_instructions_for_ai: '',

    platform_authors: {},
  };
}

export interface WritePersonaResult {
  path: string;
  alreadyExisted: boolean;
}

/**
 * Write the persona YAML. Never overwrites — the same rule `add_site` and
 * `migrate` already enforce for the same reason: running `init` a second
 * time must not silently clobber edits someone made to their own file.
 */
export function writePersonaFile(personasDir: string, record: Record<string, unknown>): WritePersonaResult {
  const path = join(personasDir, `${record.slug as string}.yaml`);
  if (existsSync(path)) return { path, alreadyExisted: true };
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(path, stringify(record));
  return { path, alreadyExisted: false };
}
