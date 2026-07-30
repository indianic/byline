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
  publisherName: string;
  publisherUrl: string;
  datePublished?: string;
  faq?: FaqEntry[];
  keywords?: string[];
}

/** `</script>` inside JSON would close the injected tag early. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
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
