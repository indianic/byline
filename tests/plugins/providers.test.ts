import { describe, expect, it } from 'vitest';
import { providerFamilies } from '../../src/plugins/providers.js';

describe('providerFamilies', () => {
  it('includes the images family', () => {
    const ids = providerFamilies({}).map((f) => f.id);
    expect(ids).toContain('images');
  });

  it('gives every family a label, an init prompt, and its own unconfigured note', () => {
    for (const family of providerFamilies({})) {
      expect(family.label.length).toBeGreaterThan(0);
      expect(family.initPrompt.length).toBeGreaterThan(0);
      expect(family.unconfiguredNote.length).toBeGreaterThan(0);
    }
  });

  // The images note says a skipped provider is "a fallback most users skip".
  // That is TRUE for images and FALSE for research — there is no research
  // fallback. A shared note would carry one family's semantics into the other,
  // which is condition (b) from docs/ADDING-A-PLATFORM.md.
  it('does not share one unconfigured note across families', () => {
    const notes = providerFamilies({}).map((f) => f.unconfiguredNote);
    expect(new Set(notes).size).toBe(notes.length);
  });

  it('resolves each provider against the env it is handed, not process.env', () => {
    const images = providerFamilies({})!.find((f) => f.id === 'images')!;
    expect(images.providers({}).every((p) => !p.configured())).toBe(true);
    const withKey = images.providers({ GEMINI_API_KEY: 'k' });
    expect(withKey.some((p) => p.configured())).toBe(true);
  });

  it('includes the research family', () => {
    expect(providerFamilies({}).map((f) => f.id)).toContain('research');
  });

  it('gives research a note that does NOT promise a fallback', () => {
    const research = providerFamilies({}).find((f) => f.id === 'research')!;
    expect(research.unconfiguredNote.toLowerCase()).not.toContain('fallback');
  });

  it('resolves research providers against the env it is handed', () => {
    const research = providerFamilies({}).find((f) => f.id === 'research')!;
    expect(research.providers({}).every((p) => !p.configured())).toBe(true);
    expect(research.providers({ TAVILY_API_KEY: 'k' }).some((p) => p.configured())).toBe(true);
  });
});
