import { describe, expect, it } from 'vitest';
import { buildArticleSchema } from '../../src/craft/schema.js';

const base = {
  title: 'Outcome-Based Pricing Is Replacing IT Billable Hours',
  description: 'How AI broke the link between hours and value.',
  authorName: 'Jane Doe',
  authorRole: 'CEO',
  publisherName: 'blog.example.com',
  publisherUrl: 'https://blog.example.com',
};

function parse(script: string): Record<string, any> {
  const json = script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  return JSON.parse(json.replace(/\\u003c/g, '<'));
}

describe('buildArticleSchema', () => {
  it('emits a script tag containing an Article node', () => {
    const out = buildArticleSchema(base);
    expect(out.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(out.endsWith('</script>')).toBe(true);
    const g = parse(out);
    expect(g['@context']).toBe('https://schema.org');
    expect(g['@graph'][0]['@type']).toBe('Article');
    expect(g['@graph'][0].author).toEqual({
      '@type': 'Person',
      name: 'Jane Doe',
      jobTitle: 'CEO',
    });
  });

  it('omits the FAQPage node when no FAQ is supplied', () => {
    expect(parse(buildArticleSchema(base))['@graph']).toHaveLength(1);
  });

  it('adds a FAQPage node mirroring the supplied questions', () => {
    const g = parse(
      buildArticleSchema({
        ...base,
        faq: [
          { question: 'What is outcome-based pricing?', answer: 'Payment tied to a result.' },
          { question: 'Why now?', answer: 'AI compressed delivery effort.' },
        ],
      }),
    );
    expect(g['@graph']).toHaveLength(2);
    expect(g['@graph'][1]['@type']).toBe('FAQPage');
    expect(g['@graph'][1].mainEntity).toHaveLength(2);
    expect(g['@graph'][1].mainEntity[0]).toEqual({
      '@type': 'Question',
      name: 'What is outcome-based pricing?',
      acceptedAnswer: { '@type': 'Answer', text: 'Payment tied to a result.' },
    });
  });

  // A literal </script> inside the JSON would close the injected tag early and
  // spill the remainder into the page as markup.
  it('escapes angle brackets so the script tag cannot be broken out of', () => {
    const out = buildArticleSchema({
      ...base,
      faq: [{ question: 'Is </script> safe?', answer: 'It must be escaped.' }],
    });
    expect(out).not.toContain('</script> safe');
    expect(out.match(/<\/script>/g)).toHaveLength(1);
    expect(parse(out)['@graph'][1].mainEntity[0].name).toBe('Is </script> safe?');
  });

  it('truncates an over-long headline to the schema.org limit', () => {
    const g = parse(buildArticleSchema({ ...base, title: 'x'.repeat(200) }));
    expect(g['@graph'][0].headline.length).toBe(110);
  });

  it('includes url, image and dates only when supplied', () => {
    const bare = parse(buildArticleSchema(base))['@graph'][0];
    expect(bare.url).toBeUndefined();
    expect(bare.image).toBeUndefined();
    expect(bare.datePublished).toBeUndefined();

    const full = parse(
      buildArticleSchema({
        ...base,
        url: 'https://blog.example.com/p/x/',
        imageUrl: 'https://blog.example.com/content/images/hero.png',
        datePublished: '2026-07-28T00:00:00.000Z',
        keywords: ['AI', 'IT services'],
      }),
    )['@graph'][0];
    expect(full.url).toBe('https://blog.example.com/p/x/');
    expect(full.image).toEqual(['https://blog.example.com/content/images/hero.png']);
    expect(full.dateModified).toBe('2026-07-28T00:00:00.000Z');
    expect(full.keywords).toBe('AI, IT services');
  });
});
