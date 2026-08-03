import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse, stringify } from 'yaml';
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
 * One question, in whichever of its two modes applies.
 *
 * With a `current` value the question offers to keep it and an empty answer
 * does exactly that. Without one — a persona being created — the question and
 * its skip semantics are byte-for-byte what they have always been, so the
 * abort-on-skip rule below is unaffected by the existence of the other mode.
 *
 * Every prompt in this codebase supplies a `placeholder` — see promptSlug,
 * promptUrl, collectCredentialValues — and these five did not. That was not
 * just an inconsistency: @clack's text() renders the literal string
 * "undefined" as the confirmed value when Enter is pressed on empty input
 * with no placeholder set, which is real and was seen live in a terminal,
 * not guessed at.
 */
async function askKeeping(
  p: Prompter,
  current: string | undefined,
  question: string,
  placeholder: string,
): Promise<string | null> {
  if (current) {
    const answer = await p.text({ message: `${question} (Enter to keep "${current}")`, placeholder: current });
    return answer ?? current;
  }
  return p.text({ message: `${question} (Enter nothing to skip)`, placeholder });
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
 *
 * `current` switches this to the update walk, where each answer defaults to
 * what the file already says and an empty answer keeps it — so re-running
 * `init` to change one thing does not mean retyping the other four. A field
 * that is currently EMPTY still asks as if new, which is what keeps the
 * abort-on-skip rule intact: the update path can only ever preserve a value
 * that exists.
 */
export async function promptPersonaAnswers(
  p: Prompter = clackPrompter,
  current?: PersonaAnswers,
): Promise<PersonaAnswers | null> {
  const name = await askKeeping(p, current?.name, 'Your name — used as the byline', 'Alex Chen');
  if (!name) return null;

  const role = await askKeeping(p, current?.role, 'Your role or title', 'Senior Engineer, Freelance Journalist');
  if (!role) return null;

  const styleAndTone = await askKeeping(
    p,
    current?.styleAndTone,
    'Your writing style and tone, in a few words',
    'Analytical, direct, confident',
  );
  if (!styleAndTone) return null;

  const currentYears = current && current.yearsOfExperience > 0 ? String(current.yearsOfExperience) : undefined;
  const yearsRaw = await askKeeping(p, currentYears, 'Years of experience', '10');
  const parsedYears = yearsRaw ? Number.parseInt(yearsRaw, 10) : NaN;
  const yearsOfExperience = Number.isFinite(parsedYears) && parsedYears > 0 ? parsedYears : 0;

  const subjectExpertise = await askKeeping(
    p,
    current?.subjectExpertise || undefined,
    'Your main subject expertise',
    'cloud architecture, personal finance',
  );

  return { name, role, styleAndTone, yearsOfExperience, subjectExpertise: subjectExpertise ?? '' };
}

/** A persona file already on disk, with its raw contents kept for a non-destructive update. */
export interface ExistingPersona {
  /** The filename stem, which `loadPersonas` requires the `slug` field to equal. */
  slug: string;
  path: string;
  /**
   * The YAML mapping exactly as it is on disk — every field, including the
   * twenty the five questions never ask about. An update merges into THIS
   * rather than rebuilding from `buildPersonaRecord`, because rebuilding would
   * blank a hand-written `persona_specific_instructions_for_ai`,
   * `platform_authors`, and everything else someone filled in by editing the
   * file, which is the workflow `init` itself tells them to use.
   */
  record: Record<string, unknown>;
  /** The five questionnaire answers as this file currently expresses them. */
  answers: PersonaAnswers;
}

/**
 * Every persona already configured, read tolerantly.
 *
 * Deliberately NOT `loadPersonas`: that validates against `PersonaSchema` and
 * throws for the WHOLE directory when any one file fails, which would mean one
 * hand-broken persona makes `init` unable to even ASK about the others. This is
 * a menu, not a load — a file it cannot parse is skipped and `doctor` is where
 * the parse failure gets reported.
 *
 * A missing directory is not an error and creates nothing: `init` must not
 * bring the config home into being just by looking (Finding 2).
 */
export function readExistingPersonas(personasDir: string): ExistingPersona[] {
  let files: string[];
  try {
    files = readdirSync(personasDir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'));
  } catch {
    return [];
  }

  const found: ExistingPersona[] = [];
  for (const file of files.sort()) {
    const path = join(personasDir, file);
    let parsed: unknown;
    try {
      parsed = parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    // The filename stem, not `record.slug`: this is the file that will be
    // rewritten, and `loadPersonas` rejects the pair when they disagree.
    const slug = basename(file).replace(/\.ya?ml$/, '');
    found.push({ slug, path, record, answers: personaAnswersFrom(record, slug) });
  }
  return found;
}

/** Read the five questionnaire answers back out of a persona record. */
export function personaAnswersFrom(record: Record<string, unknown>, slug: string): PersonaAnswers {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    name: str(record.name) || slug,
    role: str(record.role),
    styleAndTone: str(record.writing_style),
    yearsOfExperience: typeof record.years_of_experience === 'number' ? record.years_of_experience : 0,
    subjectExpertise: str(record.subject_expertise),
  };
}

/**
 * Apply the five answers to an existing persona record, changing nothing else.
 *
 * `slug` is forced to the filename stem so the rewritten file still satisfies
 * `loadPersonas`' filename-equals-slug rule — including when the user changes
 * their NAME, which is the one answer that would otherwise derive a different
 * slug and leave two persona files where there was one.
 */
export function updatePersonaRecord(
  existing: Record<string, unknown>,
  answers: PersonaAnswers,
  slug: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...existing, slug };
  record.name = answers.name;
  record.role = answers.role;
  record.years_of_experience = answers.yearsOfExperience;
  record.subject_expertise = answers.subjectExpertise;

  // `buildPersonaRecord` writes writing_style and tone_of_voice from ONE
  // answer, so on a file `init` created the two are equal. Someone who has
  // since edited tone_of_voice to say something different meant it, and
  // driving both from one answer here would silently discard that edit — the
  // same reason the record above is merged rather than rebuilt.
  const coupled = existing.tone_of_voice === existing.writing_style;
  record.writing_style = answers.styleAndTone;
  if (coupled) record.tone_of_voice = answers.styleAndTone;

  return record;
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
 * Write the persona YAML. Never overwrites unless `replace: true` is passed —
 * the same rule `add_site`, `migrate`, and `writeSiteToConfig` already enforce
 * for the same reason: running `init` a second time must not silently clobber
 * edits someone made to their own file.
 *
 * `replace: true` exists for exactly one caller — `init`'s update flow, which
 * reaches it only after the user picked this persona off a menu of what is
 * already there and answered a questionnaire pre-filled from the file's own
 * contents. `alreadyExisted` still reports what was found, so the caller can
 * say whether it wrote a new file or changed one.
 */
export function writePersonaFile(
  personasDir: string,
  record: Record<string, unknown>,
  options: { replace?: boolean } = {},
): WritePersonaResult {
  const path = join(personasDir, `${record.slug as string}.yaml`);
  const alreadyExisted = existsSync(path);
  if (alreadyExisted && !options.replace) return { path, alreadyExisted: true };
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(path, stringify(record));
  return { path, alreadyExisted };
}
