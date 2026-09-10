export interface FaqEntry {
  question: string;
  answer: string;
}

export interface SchemaInput {
  title: string;
  description: string;
  url?: string;
  imageUrl?: string;
  authorName: string;
  authorRole?: string;
  /**
   * The author's own profile URLs — a canonical bio page, a LinkedIn or
   * X profile — emitted as `author.sameAs`. A generative engine resolves an
   * ambiguous name (there is more than one "Jane Doe") through exactly this
   * kind of entity-linking signal; an author node with no `sameAs` is
   * anonymous to anything that is not this one site.
   */
  authorUrls?: string[];
  publisherName: string;
  publisherUrl: string;
  datePublished?: string;
  faq?: FaqEntry[];
  keywords?: string[];
  /**
   * A BCP 47 language tag (e.g. "en", "hi") — never a plain language name.
   * Callers derive this from the persona's `language_written` (which is
   * often a name, e.g. "English") via `languageTag()` below, and pass the
   * result only when it resolved to something; a name `languageTag` does
   * not recognise means this is omitted rather than sending a fabricated or
   * wrong tag.
   */
  inLanguage?: string;
  /** Word count of the published article, from the stripped HTML. */
  wordCount?: number;
}

/** `</script>` inside JSON would close the injected tag early. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** A small set of common language names, mapped to their BCP 47 tag. */
const LANGUAGE_NAME_TO_TAG: Record<string, string> = {
  english: 'en',
  hindi: 'hi',
  gujarati: 'gu',
  marathi: 'mr',
  bengali: 'bn',
  tamil: 'ta',
  telugu: 'te',
  kannada: 'kn',
  malayalam: 'ml',
  punjabi: 'pa',
  urdu: 'ur',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  portuguese: 'pt',
  italian: 'it',
  dutch: 'nl',
  japanese: 'ja',
  chinese: 'zh',
  arabic: 'ar',
  russian: 'ru',
};

/** `en`, `en-GB`, `zh-Hans` — a primary subtag of 2-3 letters, then any number of subtags. */
const BCP47_SHAPED = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/i;

/**
 * Resolve a persona's `language_written` to a BCP 47 language tag, the only
 * form `inLanguage` (schema.org / JSON-LD) may honestly carry.
 *
 * `language_written` is free text a persona author writes ("English",
 * "Hindi", "en-GB"), not itself validated as a tag — Byline used to ship
 * "English" straight through as `inLanguage`, which is not a BCP 47 tag
 * despite the field's own doc comment calling it one. A value that already
 * looks like a tag passes through unchanged (so "en-GB", "hi", "zh-Hans" all
 * work); a common name is mapped; anything else — an unrecognised name, a
 * typo — returns `undefined` rather than a guess, so the caller omits
 * `inLanguage` entirely instead of asserting a fabricated or wrong tag.
 */
export function languageTag(name: string): string | undefined {
  const trimmed = name.trim();
  if (BCP47_SHAPED.test(trimmed)) return trimmed;
  return LANGUAGE_NAME_TO_TAG[trimmed.toLowerCase()];
}

/**
 * Build the JSON-LD block injected into a post's page head.
 *
 * Emits an Article node always, plus a FAQPage node when FAQ entries are supplied.
 * Generative and answer engines use this to attribute a claim to a named author
 * and date — an unattributed page is far less likely to be cited.
 *
 * The FAQ entries MUST match the visible page. Structured data that disagrees
 * with rendered content is a spam-policy violation, not a shortcut.
 */
export function buildArticleSchema(input: SchemaInput): string {
  const graph: Record<string, unknown>[] = [];

  const article: Record<string, unknown> = {
    '@type': 'Article',
    headline: input.title.slice(0, 110),
    description: input.description,
    author: {
      '@type': 'Person',
      name: input.authorName,
      ...(input.authorRole ? { jobTitle: input.authorRole } : {}),
      ...(input.authorUrls?.length ? { sameAs: input.authorUrls } : {}),
    },
    publisher: {
      '@type': 'Organization',
      name: input.publisherName,
      url: input.publisherUrl,
    },
  };
  if (input.url) {
    article.mainEntityOfPage = { '@type': 'WebPage', '@id': input.url };
    article.url = input.url;
  }
  if (input.imageUrl) article.image = [input.imageUrl];
  if (input.datePublished) {
    article.datePublished = input.datePublished;
    article.dateModified = input.datePublished;
  }
  if (input.keywords?.length) article.keywords = input.keywords.join(', ');
  if (input.inLanguage) article.inLanguage = input.inLanguage;
  if (input.wordCount !== undefined) article.wordCount = input.wordCount;
  graph.push(article);

  if (input.faq?.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: input.faq.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    });
  }

  return `<script type="application/ld+json">${safeJson({
    '@context': 'https://schema.org',
    '@graph': graph,
  })}</script>`;
}
