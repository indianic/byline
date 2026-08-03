import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPersonaRecord,
  personaAnswersFrom,
  promptPersonaAnswers,
  readExistingPersonas,
  slugifyPersonaName,
  updatePersonaRecord,
  writePersonaFile,
  type PersonaAnswers,
} from '../../src/cli/persona-setup.js';
import { loadPersonas, getPersona } from '../../src/config/personas.js';
import type { Prompter } from '../../src/cli/credentials.js';

/** Same double `init.test.ts` uses for `promptSlug`: returns each of `answers` in turn, then null. */
function scriptedPrompter(answers: readonly (string | null)[]): Prompter & { calls: number } {
  let i = 0;
  return {
    text: async () => {
      const v = i < answers.length ? (answers[i] ?? null) : null;
      i++;
      return v;
    },
    choose: async () => null,
    note: () => {},
    problem: () => {},
    get calls() {
      return i;
    },
  };
}

describe('slugifyPersonaName', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyPersonaName('Alex Chen')).toBe('alex-chen');
  });

  it('strips punctuation', () => {
    expect(slugifyPersonaName("O'Brien, Jr.")).toBe('o-brien-jr');
  });

  it('collapses runs and trims leading/trailing hyphens', () => {
    expect(slugifyPersonaName('  --Multiple   Spaces--  ')).toBe('multiple-spaces');
  });

  it('falls back to "author" for a name with nothing slug-safe in it', () => {
    expect(slugifyPersonaName('***')).toBe('author');
  });
});

describe('promptPersonaAnswers', () => {
  it('collects all five answers, parsing years as a number', async () => {
    const p = scriptedPrompter(['Alex Chen', 'Senior Engineer', 'Analytical, direct', '12', 'cloud architecture']);
    const answers = await promptPersonaAnswers(p);
    expect(answers).toEqual({
      name: 'Alex Chen',
      role: 'Senior Engineer',
      styleAndTone: 'Analytical, direct',
      yearsOfExperience: 12,
      subjectExpertise: 'cloud architecture',
    });
  });

  // A persona file missing name/role/writing_style/tone_of_voice fails
  // PersonaSchema, and loadPersonas throws for the WHOLE directory when even
  // one file fails to parse — so skipping a REQUIRED question must abort
  // before any of the later ones are even asked, not just before writing.
  it('aborts on the first question and asks nothing else', async () => {
    const p = scriptedPrompter([null]);
    expect(await promptPersonaAnswers(p)).toBeNull();
    expect(p.calls).toBe(1);
  });

  it('aborts when role is skipped, without asking style/years/expertise', async () => {
    const p = scriptedPrompter(['Alex Chen', null]);
    expect(await promptPersonaAnswers(p)).toBeNull();
    expect(p.calls).toBe(2);
  });

  it('aborts when style-and-tone is skipped', async () => {
    const p = scriptedPrompter(['Alex Chen', 'Senior Engineer', null]);
    expect(await promptPersonaAnswers(p)).toBeNull();
    expect(p.calls).toBe(3);
  });

  it('defaults years to 0 when skipped — that field has a real default in the schema', async () => {
    const p = scriptedPrompter(['Alex Chen', 'Senior Engineer', 'Direct', null, 'cloud']);
    const answers = await promptPersonaAnswers(p);
    expect(answers?.yearsOfExperience).toBe(0);
  });

  it('defaults years to 0 rather than NaN on non-numeric input', async () => {
    const p = scriptedPrompter(['Alex Chen', 'Senior Engineer', 'Direct', 'not a number', 'cloud']);
    const answers = await promptPersonaAnswers(p);
    expect(answers?.yearsOfExperience).toBe(0);
    expect(Number.isFinite(answers?.yearsOfExperience)).toBe(true);
  });

  it('defaults subject expertise to empty string when skipped', async () => {
    const p = scriptedPrompter(['Alex Chen', 'Senior Engineer', 'Direct', '5', null]);
    const answers = await promptPersonaAnswers(p);
    expect(answers?.subjectExpertise).toBe('');
  });
});

describe('buildPersonaRecord', () => {
  const answers: PersonaAnswers = {
    name: 'Alex Chen',
    role: 'Senior Engineer',
    styleAndTone: 'Analytical, direct',
    yearsOfExperience: 12,
    subjectExpertise: 'cloud architecture',
  };

  it('derives slug from the name', () => {
    expect(buildPersonaRecord(answers).slug).toBe('alex-chen');
  });

  it('shares one answer between writing_style and tone_of_voice', () => {
    const r = buildPersonaRecord(answers);
    expect(r.writing_style).toBe('Analytical, direct');
    expect(r.tone_of_voice).toBe('Analytical, direct');
  });
});

describe('writePersonaFile', () => {
  it('writes to <personasDir>/<slug>.yaml, creating the directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    const result = writePersonaFile(personasDir, buildPersonaRecord({
      name: 'Alex Chen',
      role: 'Senior Engineer',
      styleAndTone: 'Direct',
      yearsOfExperience: 5,
      subjectExpertise: 'cloud',
    }));
    expect(result.alreadyExisted).toBe(false);
    expect(result.path).toBe(join(personasDir, 'alex-chen.yaml'));
    rmSync(base, { recursive: true, force: true });
  });

  // The test that actually matters, per this project's own discipline: prove
  // the file round-trips through the REAL loader, not that the object shape
  // merely looks right. A shape that "looks right" but fails PersonaSchema is
  // exactly the class of defect this codebase has shipped before.
  it('produces a file the real loadPersonas/getPersona accept', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    const answers: PersonaAnswers = {
      name: 'Jordan Reyes',
      role: 'Freelance Journalist',
      styleAndTone: 'Confident, pragmatic',
      yearsOfExperience: 8,
      subjectExpertise: 'local government',
    };
    writePersonaFile(personasDir, buildPersonaRecord(answers));

    const map = loadPersonas(personasDir);
    const persona = getPersona(map, 'jordan-reyes');
    expect(persona.name).toBe('Jordan Reyes');
    expect(persona.role).toBe('Freelance Journalist');
    expect(persona.writing_style).toBe('Confident, pragmatic');
    expect(persona.tone_of_voice).toBe('Confident, pragmatic');
    expect(persona.years_of_experience).toBe(8);
    expect(persona.subject_expertise).toBe('local government');
    rmSync(base, { recursive: true, force: true });
  });

  it('overwrites only when replace is passed, and says the file was already there', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    writePersonaFile(
      personasDir,
      buildPersonaRecord({
        name: 'Alex Chen',
        role: 'Senior Engineer',
        styleAndTone: 'Direct',
        yearsOfExperience: 5,
        subjectExpertise: 'cloud',
      }),
    );

    const result = writePersonaFile(
      personasDir,
      buildPersonaRecord({
        name: 'Alex Chen',
        role: 'Principal Engineer',
        styleAndTone: 'Direct',
        yearsOfExperience: 9,
        subjectExpertise: 'cloud',
      }),
      { replace: true },
    );

    expect(result.alreadyExisted).toBe(true);
    const persona = getPersona(loadPersonas(personasDir), 'alex-chen');
    expect(persona.role).toBe('Principal Engineer');
    expect(persona.years_of_experience).toBe(9);
    rmSync(base, { recursive: true, force: true });
  });

  it('never overwrites an existing persona file', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    const first = buildPersonaRecord({
      name: 'Alex Chen',
      role: 'Senior Engineer',
      styleAndTone: 'Direct',
      yearsOfExperience: 5,
      subjectExpertise: 'cloud',
    });
    writePersonaFile(personasDir, first);
    const before = readFileSync(join(personasDir, 'alex-chen.yaml'), 'utf8');

    const second = buildPersonaRecord({
      name: 'Alex Chen',
      role: 'Completely different role',
      styleAndTone: 'Different',
      yearsOfExperience: 1,
      subjectExpertise: 'different',
    });
    const result = writePersonaFile(personasDir, second);

    expect(result.alreadyExisted).toBe(true);
    expect(readFileSync(join(personasDir, 'alex-chen.yaml'), 'utf8')).toBe(before);
    rmSync(base, { recursive: true, force: true });
  });
});

/**
 * Re-run: a persona that is already on disk.
 *
 * The failure these cover: `init` asked all five questions, THEN discovered
 * the file existed, then discarded every answer. The fix is to know first and
 * to make each answer default to what the file already says.
 */
describe('promptPersonaAnswers with an existing persona', () => {
  const current: PersonaAnswers = {
    name: 'Alex Chen',
    role: 'Senior Engineer',
    styleAndTone: 'Analytical, direct',
    yearsOfExperience: 12,
    subjectExpertise: 'cloud architecture',
  };

  it('keeps every answer when the user presses Enter through all five', async () => {
    const p = scriptedPrompter([null, null, null, null, null]);
    expect(await promptPersonaAnswers(p, current)).toEqual(current);
  });

  it('changes only the answer the user retyped', async () => {
    const p = scriptedPrompter([null, 'Principal Engineer', null, null, null]);
    expect(await promptPersonaAnswers(p, current)).toEqual({ ...current, role: 'Principal Engineer' });
  });

  it('never returns null while updating, so a kept persona is never silently abandoned', async () => {
    // Every question has a current value, so no empty answer can be read as a
    // skip — the whole point of knowing about the file before asking.
    const p = scriptedPrompter([]);
    expect(await promptPersonaAnswers(p, current)).toEqual(current);
    expect(p.calls).toBe(5);
  });

  it('offers the current value in the question text so the user can see what Enter keeps', async () => {
    const asked: string[] = [];
    await promptPersonaAnswers(
      {
        text: async (o) => {
          asked.push(o.message);
          return null;
        },
        choose: async () => null,
        note: () => {},
        problem: () => {},
      },
      current,
    );
    expect(asked[0]).toContain('Alex Chen');
    expect(asked[3]).toContain('12');
  });

  it('still asks a currently-EMPTY field as new, so skipping it aborts as it always did', async () => {
    // A hand-edited file can be missing `role`. There is nothing to keep, so
    // the question is the new one and an empty answer means skip — which must
    // still abort, because a persona without a role fails PersonaSchema and
    // takes the whole directory down with it.
    const p = scriptedPrompter([null]);
    expect(await promptPersonaAnswers(p, { ...current, name: '', role: '' })).toBeNull();
    expect(p.calls).toBe(1);
  });
});

describe('readExistingPersonas', () => {
  it('returns nothing for a directory that does not exist, and creates nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    expect(readExistingPersonas(personasDir)).toEqual([]);
    expect(existsSync(personasDir)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('reads back the five answers from a file init itself wrote', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    const answers: PersonaAnswers = {
      name: 'Jordan Reyes',
      role: 'Freelance Journalist',
      styleAndTone: 'Confident, pragmatic',
      yearsOfExperience: 8,
      subjectExpertise: 'local government',
    };
    writePersonaFile(personasDir, buildPersonaRecord(answers));

    const found = readExistingPersonas(personasDir);
    expect(found).toHaveLength(1);
    expect(found[0]!.slug).toBe('jordan-reyes');
    expect(found[0]!.answers).toEqual(answers);
    rmSync(base, { recursive: true, force: true });
  });

  it('skips the shipped template and any file it cannot parse, rather than failing the whole run', () => {
    // `loadPersonas` throws for the WHOLE directory when one file is bad. That
    // is right for loading and wrong for a menu: one broken file must not stop
    // `init` from offering to update the others.
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, '_template.yaml'), 'slug: _template\nname: Template\n');
    writeFileSync(join(personasDir, 'broken.yaml'), 'name: [unclosed\n');
    writePersonaFile(
      personasDir,
      buildPersonaRecord({
        name: 'Alex Chen',
        role: 'Senior Engineer',
        styleAndTone: 'Direct',
        yearsOfExperience: 5,
        subjectExpertise: 'cloud',
      }),
    );

    expect(readExistingPersonas(personasDir).map((p) => p.slug)).toEqual(['alex-chen']);
    rmSync(base, { recursive: true, force: true });
  });

  it('takes the slug from the FILENAME, which is what loadPersonas insists on', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, 'on-disk.yaml'), 'slug: something-else\nname: Someone\nrole: Writer\n');
    expect(readExistingPersonas(personasDir)[0]!.slug).toBe('on-disk');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('updatePersonaRecord', () => {
  const answers: PersonaAnswers = {
    name: 'Alex Chen',
    role: 'Principal Engineer',
    styleAndTone: 'Direct',
    yearsOfExperience: 9,
    subjectExpertise: 'cloud',
  };

  it('preserves every field the five questions never ask about', () => {
    const existing = {
      ...buildPersonaRecord({ ...answers, role: 'Senior Engineer', yearsOfExperience: 5 }),
      persona_specific_instructions_for_ai: 'Never use the word "delve".',
      platform_authors: { myblog: '1234' },
      country: 'India',
    };
    const updated = updatePersonaRecord(existing, answers, 'alex-chen');
    expect(updated.role).toBe('Principal Engineer');
    expect(updated.years_of_experience).toBe(9);
    expect(updated.persona_specific_instructions_for_ai).toBe('Never use the word "delve".');
    expect(updated.platform_authors).toEqual({ myblog: '1234' });
    expect(updated.country).toBe('India');
  });

  it('forces the slug to the filename stem even when the name changed', () => {
    // Otherwise a rename derives a new slug, `loadPersonas` sees a file whose
    // slug disagrees with its name, and it throws for the whole directory.
    const existing = buildPersonaRecord(answers);
    const updated = updatePersonaRecord(existing, { ...answers, name: 'Alexander Chen' }, 'alex-chen');
    expect(updated.slug).toBe('alex-chen');
    expect(updated.name).toBe('Alexander Chen');
  });

  it('drives tone_of_voice from the one answer only while it still matches writing_style', () => {
    const coupled = buildPersonaRecord(answers);
    expect(updatePersonaRecord(coupled, { ...answers, styleAndTone: 'Playful' }, 'alex-chen')).toMatchObject({
      writing_style: 'Playful',
      tone_of_voice: 'Playful',
    });
  });

  it('does not clobber a tone_of_voice someone deliberately edited apart', () => {
    const edited = { ...buildPersonaRecord(answers), tone_of_voice: 'Warm and encouraging' };
    const updated = updatePersonaRecord(edited, { ...answers, styleAndTone: 'Playful' }, 'alex-chen');
    expect(updated.writing_style).toBe('Playful');
    expect(updated.tone_of_voice).toBe('Warm and encouraging');
  });

  it('produces a file the real loadPersonas still accepts', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-persona-'));
    const personasDir = join(base, 'personas');
    writePersonaFile(personasDir, buildPersonaRecord({ ...answers, role: 'Senior Engineer' }));

    const existing = readExistingPersonas(personasDir)[0]!;
    writePersonaFile(personasDir, updatePersonaRecord(existing.record, answers, existing.slug), { replace: true });

    const persona = getPersona(loadPersonas(personasDir), 'alex-chen');
    expect(persona.role).toBe('Principal Engineer');
    expect(persona.years_of_experience).toBe(9);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('personaAnswersFrom', () => {
  it('falls back to the slug when the file has no name, so a menu entry is never blank', () => {
    expect(personaAnswersFrom({}, 'alex-chen').name).toBe('alex-chen');
  });

  it('reads a non-numeric years_of_experience as 0 rather than propagating it', () => {
    expect(personaAnswersFrom({ years_of_experience: 'twelve' }, 'x').yearsOfExperience).toBe(0);
  });
});
