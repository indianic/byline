// The look list is DEFINED in image-style.ts and imported here, never declared
// twice. `composeImagePrompt` needs it as much as the brief does — its whole
// purpose is to work for a caller who never ran `build_writing_brief` — and two
// hand-maintained copies of one rule is exactly how SLUG_PATTERN and the image
// providers' env var names drifted in earlier phases.
import { IMAGE_LOOKS } from './image-style.js';

export { IMAGE_LOOKS };

export const HOOKS = [
  'Lead with a shocking or counterintuitive industry statistic in your very first sentence. Make the reader stop. Follow immediately with a sharp explanation of why this directly affects them.',
  'Open with a bold contrarian statement that challenges what most professionals in this space believe. Do not soften it. Let it create productive tension that the rest of the article resolves.',
  'Begin with a vivid 2-3 sentence real-world scenario the reader will personally recognise. Put them inside a familiar moment before giving them a single piece of advice.',
  'Open with one sharp rhetorical question that exposes the gap between what readers think they know and what is actually true. Pivot immediately into why this article closes that gap.',
  'Start with a micro-conflict — a specific situation where a common, widely accepted approach quietly failed in a measurable way. Name the mistake without judgment, then position the article as the solution.',
] as const;

export const ARCS = [
  'Build the article using this arc: (1) Expose the core problem readers face right now, (2) Break down why standard industry advice fails them, (3) Present a proven framework or better approach, (4) Show real-world application with concrete examples. Generate fresh topic-specific H2 headings that reflect this arc naturally — do not use generic section names.',
  'Build the article using this arc: (1) Establish what has changed in the current landscape, (2) Deep dive into the 2-3 core concepts readers must understand, (3) Walk through practical implementation step by step, (4) Define what success looks like and how to measure it. Generate fresh topic-specific H2 headings for each section.',
  'Build the article using this arc: (1) Debunk 2-3 common myths or misconceptions about this topic, (2) Lay out the true principles that actually drive results, (3) Break the process into a clear actionable sequence, (4) Close with an expert perspective or insider industry view. Generate fresh topic-specific H2 headings throughout.',
  'Build the article using this arc: (1) Open with the origin story or context behind why this topic matters now, (2) Introduce a clear framework or mental model readers can immediately apply, (3) Unpack a detailed case study or worked example, (4) Close with a specific action plan the reader can begin today. Generate fresh topic-specific H2 headings aligned to this arc.',
] as const;

export const VOICES = [
  'Write from the angle of hard-won personal experience. Use constructions like "After working through this with dozens of clients..." or "What nobody tells you is..." — make the reader feel they are receiving insider knowledge they could not find elsewhere.',
  'Write from the angle of a careful researcher who has studied this deeply. Reference patterns observed across the industry. Treat data and evidence as narrative anchors, not decoration — let them drive the story forward.',
  'Write from the angle of a trusted mentor speaking directly to someone at a professional crossroads. Be direct, specific, and warm. Avoid any advice that could apply to anyone — every point should feel written for this exact reader.',
  'Write from the angle of someone who made the wrong moves so the reader does not have to. Be candid about what did not work, what you would do differently, and why the right path is less obvious than it appears from the outside.',
] as const;

export const STORIES = [
  'Embed the micro-story as a standalone paragraph block between two H3 subsections. Open it with a specific detail — a client type, a project scenario, a date — without announcing it as a story. End with one sentence that bridges the lesson back to the section topic.',
  'Weave the micro-story into the introduction as supporting context for your opening hook. Let it flow naturally from the hook without a formal transition. Close it with the single realisation that shaped your perspective on this topic.',
  'Place the micro-story inside the most technically dense section as a human anchor. Use it to show the concept working in practice rather than in theory. Format it as a short narrative paragraph visually distinct from the surrounding instructional content.',
] as const;

export const IMAGE_PLACEMENTS = [
  'Place the [[content_image]] placeholder after the second paragraph of the introduction, before the first H2 heading.',
  'Place the [[content_image]] placeholder at the end of the first H2 section, after its final paragraph and before the second H2 heading.',
  'Place the [[content_image]] placeholder between the second and third H2 sections as a visual breathing point.',
] as const;

export const TABLE_THEMES = [
  'TABLE THEME — Professional Blue: table style="width:100%;border-collapse:collapse;margin:28px 0;font-size:15px;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);" | thead tr style="background-color:#1e3a5f;color:#ffffff;" | th style="padding:14px 18px;text-align:left;font-weight:600;letter-spacing:0.3px;" | odd td style="background-color:#ffffff;border-bottom:1px solid #e0e8f0;padding:12px 18px;" | even td style="background-color:#f0f5fb;border-bottom:1px solid #e0e8f0;padding:12px 18px;"',
  'TABLE THEME — Modern Purple: table style="width:100%;border-collapse:collapse;margin:28px 0;font-size:15px;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);" | thead tr style="background-color:#4a1d96;color:#ffffff;" | th style="padding:14px 18px;text-align:left;font-weight:600;letter-spacing:0.3px;" | odd td style="background-color:#ffffff;border-bottom:1px solid #ede9fe;padding:12px 18px;" | even td style="background-color:#f5f3ff;border-bottom:1px solid #ede9fe;padding:12px 18px;"',
  'TABLE THEME — Success Green: table style="width:100%;border-collapse:collapse;margin:28px 0;font-size:15px;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);" | thead tr style="background-color:#065f46;color:#ffffff;" | th style="padding:14px 18px;text-align:left;font-weight:600;letter-spacing:0.3px;" | odd td style="background-color:#ffffff;border-bottom:1px solid #d1fae5;padding:12px 18px;" | even td style="background-color:#ecfdf5;border-bottom:1px solid #d1fae5;padding:12px 18px;"',
  'TABLE THEME — Executive Dark: table style="width:100%;border-collapse:collapse;margin:28px 0;font-size:15px;border-radius:8px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,0.14);" | thead tr style="background-color:#111827;color:#f9fafb;" | th style="padding:14px 18px;text-align:left;font-weight:600;letter-spacing:0.3px;" | odd td style="background-color:#ffffff;border-bottom:1px solid #e5e7eb;padding:12px 18px;" | even td style="background-color:#f9fafb;border-bottom:1px solid #e5e7eb;padding:12px 18px;"',
] as const;

/**
 * Pull-quote treatments.
 *
 * A standalone <blockquote> is a NATIVE-REBUILT node on any platform whose profile
 * says `blockquote: 'native-rebuilt'`: the converter reconstructs it and discards
 * both the inline style and the inner <p>. Verified against Ghost 6.44 on
 * 2026-07-28 — a bare `<blockquote style="...">` came back as `<blockquote>`.
 * So option 1 uses no styling at all (the theme supplies it), and the styled
 * variants are tables, which such platforms pass through as raw HTML cards.
 */
export const BLOCKQUOTES = [
  'PULL-QUOTE — Native: a plain <blockquote> with the quote text directly inside it and NO style attribute and NO inner <p>. Ghost rebuilds standalone blockquotes and discards both, so any styling you write here is thrown away. The site theme styles it.',
  'PULL-QUOTE — Tinted Panel (a table, because a styled blockquote loses its styling): <table style="width:100%;border-collapse:collapse;margin:30px 0;"><tbody><tr><td style="background-color:#f5f7fa;padding:24px 28px;font-size:18px;line-height:1.7;font-style:italic;color:#1e293b;">The quote text, no attribution line needed.</td></tr></tbody></table>',
  'PULL-QUOTE — Rule Above And Below (a table, hairline rules top and bottom, no fill): <table style="width:100%;border-collapse:collapse;margin:32px 0;"><tbody><tr><td style="border-top:1px solid #cbd5e1;border-bottom:1px solid #cbd5e1;padding:22px 0;font-size:19px;line-height:1.65;font-style:italic;color:#0f172a;text-align:center;">The quote text, centred.</td></tr></tbody></table>',
] as const;

export const CTAS = [
  'Close with a reflection-based CTA. Ask the reader one specific question about how they will apply what they learned. Invite them to share their answer in the comments or bring it to their team.',
  'Close with a direct challenge-based CTA. Give the reader one concrete action they can take within the next 24 hours. Make it specific enough that there is no room to procrastinate.',
  'Close with a forward-looking CTA. Point the reader toward a related topic worth exploring next, a tool worth evaluating, or a conversation worth starting with their team.',
] as const;

/**
 * Summary-block skins, for platforms whose profile has `inlineStyles: true`.
 * Such platforms typically unwrap <div> (discarding its styling), so every one
 * of these is a <table> with inline styles instead — the container that survives
 * ingest with its styling intact. Verified against Ghost 6.44.
 */
export const SUMMARY_BLOCKS = [
  'SUMMARY BLOCK — Slate Card: <table style="width:100%;border-collapse:collapse;margin:0 0 32px 0;border-radius:10px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,0.10);"><thead><tr><th style="background-color:#0f172a;color:#f8fafc;padding:14px 22px;text-align:left;font-size:13px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">In short</th></tr></thead><tbody><tr><td style="background-color:#f8fafc;padding:20px 22px;font-size:16px;line-height:1.75;color:#0f172a;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;"> — one <strong>bolded one-sentence answer</strong> to the article\'s core question, then a <ul> of 3-4 concrete takeaways, each starting with a bolded 2-4 word label.</td></tr></tbody></table>',
  'SUMMARY BLOCK — Blue Brief: <table style="width:100%;border-collapse:collapse;margin:0 0 32px 0;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(30,58,95,0.12);"><thead><tr><th style="background-color:#1e3a5f;color:#ffffff;padding:14px 22px;text-align:left;font-size:13px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">The short answer</th></tr></thead><tbody><tr><td style="background-color:#f0f5fb;padding:20px 22px;font-size:16px;line-height:1.75;color:#12263a;border-left:1px solid #dbe6f2;border-right:1px solid #dbe6f2;border-bottom:1px solid #dbe6f2;"> — one <strong>bolded one-sentence answer</strong>, then a <ul> of 3-4 takeaways with bolded labels.</td></tr></tbody></table>',
  'SUMMARY BLOCK — Green Digest: <table style="width:100%;border-collapse:collapse;margin:0 0 32px 0;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(6,95,70,0.12);"><thead><tr><th style="background-color:#065f46;color:#ecfdf5;padding:14px 22px;text-align:left;font-size:13px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">Key takeaways</th></tr></thead><tbody><tr><td style="background-color:#f0fdf9;padding:20px 22px;font-size:16px;line-height:1.75;color:#064e3b;border-left:1px solid #cdeee2;border-right:1px solid #cdeee2;border-bottom:1px solid #cdeee2;"> — one <strong>bolded one-sentence answer</strong>, then a <ul> of 3-4 takeaways with bolded labels.</td></tr></tbody></table>',
  'SUMMARY BLOCK — Warm Editorial: <table style="width:100%;border-collapse:collapse;margin:0 0 32px 0;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(120,53,15,0.10);"><thead><tr><th style="background-color:#78350f;color:#fffbeb;padding:14px 22px;text-align:left;font-size:13px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">Before you read on</th></tr></thead><tbody><tr><td style="background-color:#fffbeb;padding:20px 22px;font-size:16px;line-height:1.75;color:#451a03;border-left:1px solid #fde9c8;border-right:1px solid #fde9c8;border-bottom:1px solid #fde9c8;"> — one <strong>bolded one-sentence answer</strong>, then a <ul> of 3-4 takeaways with bolded labels.</td></tr></tbody></table>',
] as const;

/**
 * Mid-article emphasis panels, table-based for the same reason.
 *
 * Deliberately three different treatments rather than one shape in three colours:
 * a tinted panel with no rule, a hairline-bordered panel, and a top-rule panel.
 * A tinted card with a thick left rule is the single most recognisable
 * AI-generated-UI tell, so no variant uses one.
 */
export const CALLOUTS = [
  'CALLOUT PANEL — Quiet Tint (no rules at all, relies on background and generous padding): <table style="width:100%;border-collapse:collapse;margin:28px 0;"><tbody><tr><td style="background-color:#f6f7f9;padding:22px 26px;font-size:15px;line-height:1.75;color:#1f2937;"><strong style="display:inline;">Short bolded label.</strong> Then the point itself, two sentences at most.</td></tr></tbody></table>',
  'CALLOUT PANEL — Hairline Frame (1px border on all four sides, white fill, no tint): <table style="width:100%;border-collapse:collapse;margin:28px 0;"><tbody><tr><td style="background-color:#ffffff;border:1px solid #d4d9e0;padding:20px 24px;font-size:15px;line-height:1.75;color:#111827;"><strong>Short bolded label.</strong> Then the point itself, two sentences at most.</td></tr></tbody></table>',
  'CALLOUT PANEL — Top Rule (a 2px accent rule across the TOP edge only, never the side): <table style="width:100%;border-collapse:collapse;margin:28px 0;"><tbody><tr><td style="background-color:#ffffff;border-top:2px solid #1e3a5f;padding:18px 0 0 0;font-size:15px;line-height:1.75;color:#111827;"><strong>Short bolded label.</strong> Then the point itself, two sentences at most.</td></tr></tbody></table>',
] as const;

/**
 * Structural equivalents for platforms that strip inline styles.
 *
 * WordPress runs KSES on content from users without the `unfiltered_html`
 * capability, which removes every `style=` attribute. On such a site the styled
 * variants above publish as unstyled markup at best, and are rejected by
 * score_draft's blocking platform_html check before that. These say the same
 * things structurally and let the theme do the styling.
 */
export const PLAIN_SUMMARY_BLOCKS = [
  'SUMMARY BLOCK — Plain: a <table> with a <thead> row reading "In short" and one <tbody> cell containing a <strong>bolded one-sentence answer</strong> to the article\'s core question, then a <ul> of 3-4 takeaways each opening with a bolded 2-4 word label. NO style attributes anywhere — the site theme styles the table.',
] as const;

export const PLAIN_CALLOUTS = [
  'CALLOUT PANEL — Plain: a <table> with a single cell containing <strong>Short bolded label.</strong> followed by the point itself, two sentences at most. NO style attributes.',
] as const;

export const PLAIN_BLOCKQUOTES = [
  'PULL-QUOTE — Plain: a <blockquote> with the quote text directly inside it and no style attribute.',
] as const;

export const PLAIN_TABLE_THEMES = [
  'TABLE THEME — Plain: a <table> with <thead>/<tbody> and no style attributes. The site theme supplies the visual treatment.',
] as const;

/**
 * Pick the dimension set matching what the target platform preserves.
 * Styled variants are used only where inline styles actually survive.
 */
export function dimensionsFor(inlineStyles: boolean) {
  return {
    hook: HOOKS,
    arc: ARCS,
    voice: VOICES,
    story: STORIES,
    imagePlacement: IMAGE_PLACEMENTS,
    tableTheme: inlineStyles ? TABLE_THEMES : PLAIN_TABLE_THEMES,
    blockquote: inlineStyles ? BLOCKQUOTES : PLAIN_BLOCKQUOTES,
    cta: CTAS,
    summaryBlock: inlineStyles ? SUMMARY_BLOCKS : PLAIN_SUMMARY_BLOCKS,
    callout: inlineStyles ? CALLOUTS : PLAIN_CALLOUTS,
    // Last on purpose. `buildBrief` consumes one RNG draw per dimension in
    // insertion order, so appending keeps every existing seed → pick mapping
    // intact; inserting higher up would silently rewrite every brief anyone
    // had reproduced from a stored seed.
    //
    // Does not vary by `inlineStyles` — a platform's HTML filtering has
    // nothing to do with photography.
    imageLook: IMAGE_LOOKS,
  } as const;
}

export const DIMENSIONS = {
  hook: HOOKS,
  arc: ARCS,
  voice: VOICES,
  story: STORIES,
  imagePlacement: IMAGE_PLACEMENTS,
  tableTheme: TABLE_THEMES,
  blockquote: BLOCKQUOTES,
  cta: CTAS,
  summaryBlock: SUMMARY_BLOCKS,
  callout: CALLOUTS,
  imageLook: IMAGE_LOOKS,
} as const;

export type DimensionName = keyof typeof DIMENSIONS;
