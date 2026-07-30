import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPersonaRecord,
  promptPersonaAnswers,
  slugifyPersonaName,
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
