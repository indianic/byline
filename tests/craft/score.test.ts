import { describe, expect, it } from 'vitest';
import { scoreDraft } from '../../src/craft/score.js';
import { HUMAN_TEXTURES, PERSONA_PRESENCES } from '../../src/craft/dimensions.js';
import { GHOST_HTML_PROFILE } from '../../src/plugins/platforms/ghost/html-profile.js';
import { buildProfile } from '../../src/plugins/platforms/wordpress/html-profile.js';

// A draft that satisfies ALL THIRTEEN checks at once, in blog mode against the
// Ghost profile with no feature image and no research findings.
//
// It exists because nothing else in this suite proved a full `pass` was
// reachable. Every other fixture here isolates one check, so the suite could
// have stayed green while some combination of rules was jointly unsatisfiable —
// and the rules genuinely do pull against each other (short punchy sentences
// help `paragraph_uniformity` and hurt `burstiness`; the summary-block
// container has to be one Ghost keeps styled). If a future threshold change
// makes a clean article impossible to write, this is the test that fails.
const CLEAN_BLOG_HTML = [
  "<table style=\"border:1px solid #ddd;background:#fafafa;\"><tr><td>In short: our deploy took 41 minutes, and the fix had nothing to do with the build step.</td></tr></table>",
  "<h2>What actually slows a deployment down?</h2>",
  "<p>Our pipeline took 41 minutes. I assumed the compiler was the problem.</p>",
  "<p>It wasn't. When we finally measured the thing properly, instead of trading theories about it across a standup that had been having the same argument for a month, the wait turned out to be 78% queueing. According to <a href=\"https://dora.dev/research/\" rel=\"noopener noreferrer\">the 2024 DORA report</a>, that split is ordinary rather than exceptional.</p>",
  "<p>I had spent three weeks tuning a build that was never the bottleneck.</p>",
  "<h2>How do you find the real bottleneck?</h2>",
  "<p>Instrument the queue before you touch the build.</p>",
  "<p>We added timestamps at four points: job created, runner assigned, checkout complete, artifact pushed. The gap between the first two was 31 minutes on a bad afternoon and under 40 seconds at 7am, which told us more in one day than the previous month of profiling had.</p>",
  "<p>The team pushed back hard on that, and they were right to \u2014 instrumentation is not free, and I had already cried wolf once.</p>",
  "<p>[[content_image]]</p>",
  "<p>Research from <a href=\"https://www.thoughtworks.com/radar\" rel=\"noopener noreferrer\">Thoughtworks</a> says much the same thing about concurrency limits. Data from our own runner logs put the ceiling at 12 concurrent jobs against 40 developers.</p>",
  "<h2>Is more compute the answer?</h2>",
  "<p>Usually not, and it is the expensive way to find out.</p>",
  "<p>We doubled the runner pool. Deploy time fell from 41 minutes to 22, which looked like a win until the bill arrived and we realised we had paid a 90% infrastructure increase for a 46% improvement that a scheduling change delivered for nothing two months later.</p>",
  "<p>I killed that experiment in week six.</p>",
  "<table style=\"border-collapse:collapse;\"><thead><tr><th style=\"border:1px solid #ccc;\">Change</th><th style=\"border:1px solid #ccc;\">Deploy time</th><th style=\"border:1px solid #ccc;\">Monthly cost</th></tr></thead><tbody><tr><td style=\"border:1px solid #ccc;\">Baseline</td><td style=\"border:1px solid #ccc;\">41 min</td><td style=\"border:1px solid #ccc;\">$1,200</td></tr><tr><td style=\"border:1px solid #ccc;\">Doubled runners</td><td style=\"border:1px solid #ccc;\">22 min</td><td style=\"border:1px solid #ccc;\">$2,280</td></tr><tr><td style=\"border:1px solid #ccc;\">Queue rewrite</td><td style=\"border:1px solid #ccc;\">6 min</td><td style=\"border:1px solid #ccc;\">$1,200</td></tr></tbody></table>",
  "<p>The scheduling change won.</p>",
  "<h2>Frequently asked questions</h2>",
  "<h3>How long should a deploy take?</h3>",
  "<p>Short enough that nobody batches changes to avoid it. For us that number was under ten minutes, and the study published by <a href=\"https://cloud.google.com/devops\" rel=\"noopener noreferrer\">Google Cloud</a> in 2024 reported similar thresholds across 3,000 teams.</p>",
  "<h3>Does this apply to a small team?</h3>",
  "<p>More so. We had 40 engineers and a ceiling of 12 concurrent jobs; a team of six on the same runner configuration hits the wall sooner per person, not later.</p>"
].join('\n');

const find = (html: string, name: string) =>
  scoreDraft(html, GHOST_HTML_PROFILE).checks.find((c) => c.name === name)!;

describe('AI-tell lexicon', () => {
  it('flags banned words and reports each one', () => {
    const c = find('<p>A seamless and robust solution to delve into.</p>', 'ai_lexicon');
    expect(c.ok).toBe(false);
    expect(c.findings.join(' ')).toMatch(/seamless/);
    expect(c.findings.join(' ')).toMatch(/robust/);
    expect(c.findings.join(' ')).toMatch(/delve/);
  });

  it('flags the not-just-X-it-is-Y construction', () => {
    expect(find("<p>It's not just a tool, it's a platform.</p>", 'ai_lexicon').ok).toBe(false);
  });

  it('passes clean prose', () => {
    expect(
      find('<p>We shipped it on a Tuesday and it broke by Thursday.</p>', 'ai_lexicon').ok,
    ).toBe(true);
  });
});

describe('burstiness', () => {
  it('fails uniform sentence lengths', () => {
    const s =
      'The team built the thing today. The team shipped the thing today. The team fixed the thing today. The team broke the thing today. The team wrote the thing today.';
    const c = find(`<p>${s}</p>`, 'burstiness');
    expect(c.ok).toBe(false);
  });

  it('passes varied sentence lengths', () => {
    const s =
      'It failed. After we rewrote the ingestion layer, moved the queue off Redis, and finally admitted the original schema was wrong, the throughput problem disappeared overnight. We were wrong. That took four months of arguing about the wrong thing before anyone measured it properly.';
    expect(find(`<p>${s}</p>`, 'burstiness').ok).toBe(true);
  });
});

describe('platform_html', () => {
  it('rejects a <br> tag', () => {
    expect(find('<p>a<br>b</p>', 'platform_html').ok).toBe(false);
  });

  it('reports a <br> tag once, not once from the explicit rule and again as a disallowed tag', () => {
    const c = find('<p>a<br>b</p>', 'platform_html');
    const brFindings = c.findings.filter((f) => f.toLowerCase().includes('br'));
    expect(brFindings).toHaveLength(1);
    expect(brFindings[0]).toContain('use separate <p> tags');
  });

  // Regression: the explicit rule above only matches `<br>`, `<br/>`, `<br />` via
  // `/<br\s*\/?>/i`. A prior fix suppressed ALL `br` reporting in the tag-scanning
  // loop to dedupe the plain case, which silently stopped flagging every other
  // form of `<br>` the narrow regex doesn't match — an invalid-HTML blocker
  // quietly turning into a pass. Every one of these must still be flagged.
  it.each([
    ['<p>x</br>y</p>', 'closing </br>'],
    ['<p>x<br data-z="1">y</p>', 'br with an attribute'],
    ['<p>x< br >y</p>', 'br with internal spacing'],
    ['<p>x<br style="clear:both">y</p>', 'br with a style attribute'],
  ])('flags %s (%s)', (html) => {
    const c = find(html, 'platform_html');
    expect(c.ok).toBe(false);
  });

  it('still reports the canonical <br>, <br/>, <br /> forms exactly once each', () => {
    for (const html of ['<p>x<br>y</p>', '<p>x<br/>y</p>', '<p>x<br />y</p>']) {
      const c = find(html, 'platform_html');
      expect(c.ok).toBe(false);
      const brFindings = c.findings.filter((f) => f.toLowerCase().includes('br'));
      expect(brFindings).toHaveLength(1);
    }
  });

  it('rejects a class attribute', () => {
    expect(find('<p class="x">a</p>', 'platform_html').ok).toBe(false);
  });

  it('rejects a hand-written heading id', () => {
    expect(find('<h2 id="mine">A</h2>', 'platform_html').ok).toBe(false);
  });

  it('rejects a disallowed tag', () => {
    expect(find('<p>a</p><script>x</script>', 'platform_html').ok).toBe(false);
  });

  it('rejects an external link without rel', () => {
    expect(find('<p><a href="https://x.com">x</a></p>', 'platform_html').ok).toBe(false);
  });

  it('does NOT require target="_blank" — Ghost strips it', () => {
    const c = find('<p><a href="https://x.com" rel="noopener noreferrer">x</a></p>', 'platform_html');
    expect(c.findings.join(' ')).not.toContain('target');
    expect(c.ok).toBe(true);
  });

  it('rejects a raw URL in text', () => {
    expect(find('<p>See https://example.com for more.</p>', 'platform_html').ok).toBe(false);
  });

  it('accepts a <div> when the profile says the platform preserves it', () => {
    // Same HTML, different platform: the finding must come from the profile,
    // not from a constant baked into the scorer.
    const permissive = {
      ...GHOST_HTML_PROFILE,
      platform: 'test',
      preserved: new Set([...GHOST_HTML_PROFILE.preserved, 'div']),
      unwrapped: new Set<string>(),
    };
    const html = '<div style="padding:8px"><p>Body text here.</p></div>';

    const strict = scoreDraft(html, GHOST_HTML_PROFILE).checks.find((c) => c.name === 'platform_html');
    const loose = scoreDraft(html, permissive).checks.find((c) => c.name === 'platform_html');

    expect(strict?.findings.join(' ')).toContain('div');
    expect(loose?.findings.join(' ')).not.toContain('div');
  });
});

describe('structure', () => {
  it('accepts a pre-injection draft with one placeholder', () => {
    expect(find('<p>a</p><p>[[content_image]]</p>', 'structure').ok).toBe(true);
  });

  // Regression: demanding exactly one placeholder blocked finished articles, where
  // the placeholder has correctly been replaced by a real <figure>.
  it('accepts a post-injection article with a real image and no placeholder', () => {
    const html = '<p>a</p><figure><img src="https://x/a.png" alt="a"></figure><p>b</p>';
    expect(find(html, 'structure').ok).toBe(true);
  });

  it('rejects an article with neither a placeholder nor an image', () => {
    const c = find('<p>a</p><p>b</p>', 'structure');
    expect(c.ok).toBe(false);
    expect(c.findings.join(' ')).toContain('no in-body image');
  });

  it('rejects more than one placeholder as ambiguous', () => {
    expect(find('<p>[[content_image]]</p><p>[[content_image]]</p>', 'structure').ok).toBe(false);
  });

  it('rejects an H3 before any H2', () => {
    expect(find('<h3>A</h3><p>[[content_image]]</p>', 'structure').ok).toBe(false);
  });
});

describe('verdict', () => {
  it('is blocked when a blocking check fails', () => {
    expect(scoreDraft('<p class="x">a</p>', GHOST_HTML_PROFILE).verdict).toBe('blocked');
  });

  it('is advisory, and still publishable, when only advisory checks fail', () => {
    const summary = '<table style="width:100%;"><tr><td>Summary</td></tr></table>';
    const html = `${summary}<h2>Heading</h2><p>${'We build things. '.repeat(30)}</p><p>[[content_image]]</p>`;
    const r = scoreDraft(html, GHOST_HTML_PROFILE);
    expect(r.checks.filter((c) => c.blocking).every((c) => c.ok)).toBe(true);
    expect(r.verdict).toBe('advisory');
    // The whole point of the rename: an advisory-only scorecard must not read
    // as a gate. A caller that publishes on `publishable` is correct to.
    expect(r.publishable).toBe(true);
    expect(r.summary).toContain('Publishable');
    expect(r.summary).toContain('none of which blocks publication');
  });

  it('is blocked and not publishable when a blocking check fails', () => {
    const r = scoreDraft('<p class="x">a</p>', GHOST_HTML_PROFILE);
    expect(r.verdict).toBe('blocked');
    expect(r.publishable).toBe(false);
    expect(r.summary).toContain('NOT publishable');
    // Naming the failing checks is what lets a caller fix them without
    // re-reading all thirteen.
    expect(r.summary).toContain('platform_html');
  });

  it('is pass and publishable when everything passes', () => {
    const r = scoreDraft(CLEAN_BLOG_HTML, GHOST_HTML_PROFILE);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
    expect(r.verdict).toBe('pass');
    expect(r.publishable).toBe(true);
  });
});

describe('ai_summary_block', () => {
  it('accepts a styled table above the first H2', () => {
    const html = '<table style="width:100%;"><tr><td>In short</td></tr></table><h2>A</h2><p>b</p>';
    expect(find(html, 'ai_summary_block').ok).toBe(true);
  });

  it('rejects an article that opens straight into prose', () => {
    expect(find('<p>Opening paragraph.</p><h2>A</h2><p>b</p>', 'ai_summary_block').ok).toBe(false);
  });

  it('explains why the container matters — an unwrapped tag would silently be stripped', () => {
    const c = find('<p>Opening paragraph.</p><h2>A</h2><p>b</p>', 'ai_summary_block');
    // Whichever tag the profile lists first as "unwrapped" — not coupled to
    // `div` specifically, since that's just wherever Set iteration happens to
    // put it for GHOST_HTML_PROFILE today.
    const firstUnwrapped = [...GHOST_HTML_PROFILE.unwrapped][0];
    expect(c.findings.join(' ')).toContain(`<${firstUnwrapped}> card would be stripped`);
  });

  // Regression (C1): a profile with an EMPTY `unwrapped` set (WordPress, for an
  // account holding unfiltered_html) must not fabricate a tag for the "would be
  // stripped" parenthetical. The old `[...profile.unwrapped][0] ?? 'div'`
  // fallback invented "div" even when nothing is unwrapped, producing a
  // self-contradicting, factually inverted message on the one platform where
  // <div> is exactly what survives.
  it('omits the "would be stripped" clause entirely when nothing is unwrapped', () => {
    const nothingUnwrapped = {
      ...GHOST_HTML_PROFILE,
      platform: 'testnowrap',
      label: 'TestNoWrap',
      unwrapped: new Set<string>(),
      visualContainers: ['div', 'blockquote'],
    };
    const html = '<p>Opening paragraph.</p><h2>A</h2><p>b</p>';
    const c = scoreDraft(html, nothingUnwrapped).checks.find((x) => x.name === 'ai_summary_block')!;
    expect(c.ok).toBe(false);
    expect(c.findings.join(' ')).not.toMatch(/would be stripped/);
    expect(c.findings.join(' ')).not.toContain('<div> card');
    expect(c.findings.join(' ')).toContain('Add a styled <div> summary block above the first H2.');
  });

  // Ghost's case (non-empty `unwrapped`) must be completely unaffected by the
  // fix above — the parenthetical still names the platform's first unwrapped tag.
  it("still explains Ghost's stripped-container case exactly as before", () => {
    const html = '<p>Opening paragraph.</p><h2>A</h2><p>b</p>';
    const c = scoreDraft(html, GHOST_HTML_PROFILE).checks.find((x) => x.name === 'ai_summary_block')!;
    const firstUnwrapped = [...GHOST_HTML_PROFILE.unwrapped][0];
    expect(c.findings.join(' ')).toContain(`would be stripped`);
    expect(c.findings.join(' ')).toContain(`<${firstUnwrapped}> card would be stripped`);
  });

  it('rejects a summary block that sits after the first H2', () => {
    const html = '<h2>A</h2><table style="width:100%;"><tr><td>late</td></tr></table>';
    expect(find(html, 'ai_summary_block').ok).toBe(false);
  });
});

describe('Ghost-stripped tags', () => {
  it('rejects a div card and explains why it would silently lose styling', () => {
    const c = find('<div style="background:#eee;">card</div><h2>A</h2>', 'platform_html');
    expect(c.ok).toBe(false);
    expect(c.findings.join(' ')).toContain('unwrapped by Ghost');
  });

  it('names every acceptable container, not just the recommended one', () => {
    const c = find('<div style="background:#eee;">card</div><h2>A</h2>', 'platform_html');
    expect(c.findings.join(' ')).toContain('<table> or <blockquote>');
  });

  it('rejects section, aside and span the same way', () => {
    for (const tag of ['section', 'aside', 'span']) {
      expect(find(`<${tag}>x</${tag}>`, 'platform_html').ok).toBe(false);
    }
  });

  // Regression: a styled blockquote publishes as Ghost's default quote card, so the
  // colours are silently thrown away — the same class of defect as target="_blank".
  it('rejects a styled blockquote and points at the working alternative', () => {
    const c = find(
      '<blockquote style="border-left:5px solid #2563eb;"><p>Quote</p></blockquote>',
      'platform_html',
    );
    expect(c.ok).toBe(false);
    expect(c.findings.join(' ')).toContain('discards the style');
  });

  it('allows a plain blockquote', () => {
    expect(find('<blockquote>Quote</blockquote><h2>A</h2>', 'platform_html').ok).toBe(true);
  });

  it('allows a styled table used as a pull-quote', () => {
    const html =
      '<table style="width:100%;"><tbody><tr><td style="font-style:italic;">Quote</td></tr></tbody></table>';
    expect(find(html, 'platform_html').ok).toBe(true);
  });

  it('allows the tags Ghost actually keeps', () => {
    const html =
      '<h4>Sub</h4><hr><p><code>x</code></p><table style="width:100%;"><tr><td>t</td></tr></table>';
    expect(find(html, 'platform_html').ok).toBe(true);
  });
});

describe('aeo_answerability', () => {
  it('passes with two question-form headings', () => {
    const html = '<h2>What is outcome pricing?</h2><p>a</p><h3>How do you start?</h3><p>b</p>';
    expect(find(html, 'aeo_answerability').ok).toBe(true);
  });

  it('fails when no heading is phrased as a question', () => {
    expect(find('<h2>Outcome pricing</h2><p>a</p>', 'aeo_answerability').ok).toBe(false);
  });
});

describe('geo_citability', () => {
  it('passes when claims are attributed', () => {
    const html =
      '<p>According to Deloitte, 67% prefer fixed fees. McKinsey reports 30% of fees are outcome-tied. A 2024 study found margins fell.</p>';
    expect(find(html, 'geo_citability').ok).toBe(true);
  });

  it('fails on bare unattributed assertions', () => {
    expect(find('<p>Most firms now use outcome pricing widely.</p>', 'geo_citability').ok).toBe(
      false,
    );
  });
});

describe('evidence and experience', () => {
  it('counts figures and citations', () => {
    const c = find('<p>Revenue grew 42% and costs fell 18% in 2026.</p>', 'evidence_density');
    expect(c.score).toBeGreaterThan(0);
  });

  it('flags an article with no first-person anecdote', () => {
    const c = find(
      `<p>${'Companies should optimise their processes. '.repeat(40)}</p>`,
      'experience_markers',
    );
    expect(c.ok).toBe(false);
  });

  // Regression: the original regex demanded a comma after the year and direct
  // adjacency between pronoun and verb, so genuinely first-hand prose scored 0.
  it('counts a year-led anecdote without a comma', () => {
    expect(find('<p>In 2023 we bid a migration at a fixed price.</p>', 'experience_markers').score)
      .toBeGreaterThan(0);
  });

  it('counts an auxiliary between the pronoun and the verb', () => {
    expect(find('<p>I have watched that exact thing happen.</p>', 'experience_markers').score)
      .toBeGreaterThan(0);
  });

  it('passes prose with two anecdotes spread across both halves', () => {
    const first = '<p>In 2023 we bid a data migration at a fixed price and delivered it early.</p>';
    const filler = `<p>${'Pricing models vary by contract structure. '.repeat(20)}</p>`;
    const second = '<p>I have watched a call-deflection target get gamed exactly that way.</p>';
    const c = find(first + filler + second, 'experience_markers');
    expect(c.ok).toBe(true);
  });

  it('still rejects third-person prose that merely uses auxiliaries', () => {
    const c = find(
      `<p>${'Organisations have optimised their delivery processes carefully. '.repeat(30)}</p>`,
      'experience_markers',
    );
    expect(c.ok).toBe(false);
  });
});

// The scorer gained an images check when the image contract landed. Two things
// about it are deliberate and easy to break: it is NON-BLOCKING, and it is
// honest that it cannot see inside a picture.
describe('images check', () => {
  const imagesCheck = (html: string, feature?: Parameters<typeof scoreDraft>[2]) =>
    scoreDraft(html, GHOST_HTML_PROFILE, feature).checks.find((c) => c.name === 'images')!;

  it('is not blocking, because at score time there is usually no image yet', () => {
    // brief → write → score → generate images → publish. A blocking check here
    // would make the normal working order impossible to satisfy.
    expect(imagesCheck('<p>hi</p>').blocking).toBe(false);
  });

  it('says plainly that it cannot check what an image depicts', () => {
    // The contract is enforced in image-style.ts. Implying the scorer verifies
    // it would be a guarantee this cannot give.
    expect(imagesCheck('<p>hi</p>').detail).toMatch(/cannot verify what an image actually depicts/i);
  });

  it('reports "not evaluated" rather than failing when no feature image is passed', () => {
    const check = imagesCheck('<p>hi</p>');
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/not evaluated/i);
  });

  it('flags a feature image with no alt text', () => {
    const check = imagesCheck('<p>hi</p>', { url: 'https://x/i.png', alt: '' });
    expect(check.ok).toBe(false);
    expect(check.findings.join(' ')).toMatch(/screen-reader/i);
  });

  it('flags alt text copy-pasted from the headline', () => {
    const check = imagesCheck('<p>hi</p>', {
      url: 'https://x/i.png',
      alt: 'AI agents in fintech',
      title: 'AI agents in fintech',
    });
    expect(check.ok).toBe(false);
    expect(check.findings.join(' ')).toMatch(/restates the article title/i);
  });

  it('does not flag alt text that merely shares vocabulary with the title', () => {
    // The guard against over-firing. Alt text SHOULD share words with the
    // article; a check that fired on that would train people to write worse
    // alt text purely to satisfy it.
    const check = imagesCheck('<p>hi</p>', {
      url: 'https://x/i.png',
      alt: 'Two analysts reviewing a fintech payment dashboard at a shared desk',
      title: 'AI agents in fintech',
    });
    expect(check.ok).toBe(true);
  });

  it('flags an in-body image with empty alt', () => {
    const check = imagesCheck('<p>hi</p><figure><img src="https://x/i.png" alt=""></figure>');
    expect(check.ok).toBe(false);
    expect(check.findings.join(' ')).toMatch(/in-body image/i);
  });

  it('accepts an in-body image that describes itself', () => {
    const check = imagesCheck(
      '<p>hi</p><figure><img src="https://x/i.png" alt="A technician tracing a cable run behind a rack"></figure>',
    );
    expect(check.ok).toBe(true);
  });
});

// The two demonstration drafts this project published were hand-authored HTML
// passed straight to create_post, never touching build_writing_brief — which is
// why they read as generic. `firstPerson` was already counted here and reported
// in the detail string, but gated nothing, so an article with no persona voice
// at all could still pass on anecdote count.
describe('experience_markers — first person', () => {
  const check = (html: string) =>
    scoreDraft(html, GHOST_HTML_PROFILE).checks.find((c) => c.name === 'experience_markers')!;

  it('fails an article with no first-person voice anywhere', () => {
    const generic =
      '<p>Predictive maintenance reduces downtime. Manufacturers report savings. ' +
      'The technology depends on sensor coverage and historical data quality. ' +
      'Adoption continues to grow across the sector.</p>';
    const r = check(generic);
    expect(r.ok).toBe(false);
    expect(r.findings.join(' ')).toMatch(/no first-person voice/i);
    // And it names the likely cause, so the fix is actionable.
    expect(r.findings.join(' ')).toMatch(/build_writing_brief/);
  });

  it('does not raise the first-person finding when the voice is there', () => {
    const voiced =
      '<p>When I first rolled this out with a client in 2019, we underestimated the ' +
      'labelling effort badly.</p><p>Filler paragraph to push the midpoint along.</p>' +
      '<p>Last year we shipped a second attempt, and I watched it fail for a different reason.</p>';
    const r = check(voiced);
    expect(r.findings.join(' ')).not.toMatch(/no first-person voice/i);
  });
});

// The cross-post defect, found by publishing the same article to both
// platforms twice (2026-07-29 and 2026-07-30) and watching the verdicts
// diverge: `pass` on Ghost, `blocked` on WordPress, same HTML.
//
// ai_summary_block accepts only the containers in profile.visualContainers. A
// styled <table> is the ONLY summary container that works on Ghost — a <div>
// there is unwrapped to bare text — and WordPress's permissive list did not
// include table. So an article written once and published to both, which is
// the workflow the README advertises, could not satisfy both checks.
describe('one article must satisfy both platforms', () => {
  const summaryTable =
    '<table style="width:100%;"><thead><tr><th>In short</th></tr></thead><tbody><tr><td>' +
    '<strong>The answer, stated completely.</strong><ul><li><strong>One:</strong> a fact.</li></ul>' +
    '</td></tr></tbody></table>';
  const article = `${summaryTable}<p>Opening.</p><h2>A section</h2><p>Body.</p>`;

  const summaryCheck = (profile: Parameters<typeof scoreDraft>[1]) =>
    scoreDraft(article, profile).checks.find((c) => c.name === 'ai_summary_block')!;

  it('accepts a <table> summary block on Ghost', () => {
    expect(summaryCheck(GHOST_HTML_PROFILE).ok).toBe(true);
  });

  it('accepts the SAME <table> summary block on a permissive WordPress account', () => {
    const wp = buildProfile(true);
    expect(summaryCheck(wp).ok).toBe(true);
  });

  it('still prefers a styled div on WordPress by listing it first', () => {
    // The fix must not demote the container that actually looks best there.
    expect(buildProfile(true).visualContainers[0]).toBe('div');
  });

  it('keeps the restrictive path on a plain table, which was never the problem', () => {
    expect(buildProfile(false).visualContainers).toEqual(['table']);
  });
});

describe('citation_provenance', () => {
  const findings = [
    { url: 'https://a.test/report', title: 'A', snippet: 's', publishedAt: null, provider: 'tavily' },
    { url: 'https://b.test/data', title: 'B', snippet: 's', publishedAt: null, provider: 'tavily' },
  ];
  const check = (html: string, f?: typeof findings) =>
    scoreDraft(html, GHOST_HTML_PROFILE, undefined, f).checks.find((c) => c.name === 'citation_provenance')!;

  it('reports not evaluated when no findings are passed, rather than passing silently', () => {
    const c = check('<p><a href="https://x.test/" rel="noopener noreferrer">x</a></p>');
    expect(c.detail).toContain('not evaluated');
    expect(c.blocking).toBe(false);
  });

  it('passes when every cited URL is in the research set', () => {
    const c = check(
      '<p><a href="https://a.test/report" rel="noopener noreferrer">r</a> and <a href="https://b.test/data" rel="noopener noreferrer">d</a></p>',
      findings,
    );
    expect(c.ok).toBe(true);
  });

  it('names a cited URL that is absent from the research set', () => {
    const c = check('<p><a href="https://invented.test/x" rel="noopener noreferrer">x</a></p>', findings);
    expect(c.ok).toBe(false);
    expect(c.findings.join(' ')).toContain('https://invented.test/x');
  });

  it('ignores utm parameters, a trailing slash, and host case when matching', () => {
    // A raw `&` between query params is invalid HTML — correctly-written
    // markup uses `&amp;` here. Using `&amp;` is the load-bearing part of
    // this test: it goes red if entity decoding is dropped.
    const c = check(
      '<p><a href="https://A.TEST/report/?utm_source=x&amp;utm_campaign=y" rel="noopener noreferrer">r</a> <a href="https://b.test/data" rel="noopener noreferrer">d</a></p>',
      findings,
    );
    expect(c.ok).toBe(true);
  });

  it('ignores a leading www. and http vs https when matching', () => {
    const c = check(
      '<p><a href="https://www.a.test/report" rel="noopener noreferrer">r</a> <a href="http://b.test/data" rel="noopener noreferrer">d</a></p>',
      findings,
    );
    expect(c.ok).toBe(true);
  });

  it('accepts a single-quoted href', () => {
    const c = check("<p><a href='https://a.test/report' rel='noopener noreferrer'>r</a></p>", findings);
    expect(c.findings.join(' ')).not.toContain('https://a.test/report');
  });

  it('captures a double-quoted href containing an apostrophe, rather than skipping the anchor', () => {
    // A `(["'])...\1` backreference pattern would stop at the apostrophe and
    // fail to find the closing `"`, dropping the whole anchor — reported as
    // "0 cited URL(s)" instead of naming the invented URL.
    const c = check(
      '<p><a href="https://invented.test/report\'s-sequel" rel="noopener noreferrer">x</a></p>',
      findings,
    );
    expect(c.detail).toContain('1 cited URL(s)');
    expect(c.ok).toBe(false);
    expect(c.findings.join(' ')).toContain("https://invented.test/report's-sequel");
  });

  it('ignores query-parameter order when matching', () => {
    const reordered = [
      { url: 'https://a.test/report?a=1&b=2', title: 'A', snippet: 's', publishedAt: null, provider: 'tavily' },
    ];
    const c = check(
      '<p><a href="https://a.test/report?b=2&amp;a=1" rel="noopener noreferrer">r</a></p>',
      reordered,
    );
    expect(c.ok).toBe(true);
  });

  it('counts a duplicated citation once on each side of the detail sentence', () => {
    const invented = check(
      '<p><a href="https://invented.test/x" rel="noopener noreferrer">x</a> <a href="https://invented.test/x" rel="noopener noreferrer">x again</a></p>',
      findings,
    );
    expect(invented.detail).toContain('1 cited URL(s)');
    expect(invented.detail).toContain('0 traceable');

    const real = check(
      '<p><a href="https://a.test/report" rel="noopener noreferrer">r</a> <a href="https://a.test/report" rel="noopener noreferrer">r again</a></p>',
      findings,
    );
    expect(real.detail).toContain('1 cited URL(s)');
    expect(real.detail).toContain('1 traceable');
  });

  it('reports research sources the draft never cited, informationally', () => {
    const c = check('<p><a href="https://a.test/report" rel="noopener noreferrer">r</a></p>', findings);
    expect(c.findings.join(' ')).toContain('https://b.test/data');
  });

  it('reports not evaluated for an empty findings array, not "0 traceable"', () => {
    const c = check('<p><a href="https://x.test/" rel="noopener noreferrer">x</a></p>', []);
    expect(c.detail).toContain('not evaluated');
    expect(c.ok).toBe(true);
  });

  // Advisory, never blocking: a writer legitimately links a homepage or a
  // definition page that no search returned, and blocking would forbid every
  // non-research link.
  it('is advisory, so an uncited-source draft is not blocked', () => {
    const card = scoreDraft(
      '<p><a href="https://invented.test/x" rel="noopener noreferrer">x</a></p>',
      GHOST_HTML_PROFILE,
      undefined,
      findings,
    );
    expect(card.checks.find((c) => c.name === 'citation_provenance')!.blocking).toBe(false);
  });
});

describe('experience_markers agrees with what the brief actually teaches', () => {
  const markers = (html: string) =>
    scoreDraft(html, GHOST_HTML_PROFILE).checks.find((c) => c.name === 'experience_markers')!;

  // ONE RULE, ONE DEFINITION — across two modules this time. `PERSONA_PRESENCES`
  // teaches an author to show seniority through the room rather than the
  // résumé and gives these as its worked examples. Before this, none of them
  // matched, so a real draft written exactly to that instruction scored ZERO
  // first-hand moments and score_draft told the writer to add some.
  it.each([
    'We killed the pilot in week six.',
    'The team pushed back hard on that.',
    'The client had already signed before anyone asked engineering.',
    'For years I called this a tooling problem.',
    'I used to treat this as a change-management problem.',
  ])('recognises %o, which the brief instructs verbatim', (sentence) => {
    // Doubled so the >= 2 threshold is not what is under test here; this is
    // about whether the construction is seen at all.
    expect(markers(`<p>${sentence} ${sentence}</p>`).score).toBeGreaterThanOrEqual(2);
  });

  // The examples above are drawn from the real option strings, so if someone
  // edits a variant to teach a different construction this fails rather than
  // silently drifting.
  it('sources those examples from the shipped persona-presence options', () => {
    const all = PERSONA_PRESENCES.join(' ');
    expect(all).toContain('We killed the pilot in week six.');
    expect(all).toContain('The team pushed back hard on that.');
    expect(all).toContain('The client had already signed before anyone asked engineering.');
    expect(HUMAN_TEXTURES.join(' ')).toContain('For years I called this a tooling problem.');
  });

  // Widening the verb list must not turn every opinion into an anecdote.
  // "I think", "we believe" and bare first person are stance, not experience.
  it.each([
    '<p>I think this is the right approach. We believe it will work.</p>',
    '<p>We are seeing more of this. I am not convinced by any of it.</p>',
    '<p>In my opinion the tooling is fine. Our view is that it is a people problem.</p>',
  ])('does not count bare opinion as a first-hand moment: %o', (html) => {
    expect(markers(html).score).toBe(0);
  });

  it('still requires two moments and one after the midpoint', () => {
    const early = '<p>We killed the pilot in week six.</p>' + '<p>Filler. </p>'.repeat(40);
    const m = markers(early);
    expect(m.ok).toBe(false);
    expect(m.findings.join(' ')).toContain('after the midpoint');
  });
});

describe('news mode scores by the opposite standard', () => {
  const REPORT =
    '<p>MUMBAI, August 1 — The Reserve Bank of India tightened disclosure rules for digital lending apps on Friday, ' +
    'requiring every lender to publish borrowing costs before a loan is sanctioned.</p>' +
    '<p>The circular, published on the central bank&rsquo;s website on August 1, applies to all regulated entities from October 1, according to the notification.</p>' +
    '<p>&ldquo;Borrowers must see the full cost up front,&rdquo; said Rajeshwar Rao, deputy governor, in a statement on Friday.</p>' +
    '<p>Digital lending disbursals reached 1.46 trillion rupees in the year to March, data from the Fintech Association showed.</p>' +
    '<p>Two lenders told this reporter they would need six months to comply. A third did not respond to a request for comment.</p>';

  const check = (html: string, mode: 'blog' | 'news', name: string) =>
    scoreDraft(html, GHOST_HTML_PROFILE, undefined, undefined, mode).checks.find((c) => c.name === name);

  // The brief's news block forbids first person outright. Scoring that as a
  // missing-experience failure tells the writer to break the brief they were
  // just given.
  it('does not demand first-hand experience of a report', () => {
    expect(check(REPORT, 'news', 'experience_markers')).toBeUndefined();
    expect(check(REPORT, 'news', 'reporter_voice')!.ok).toBe(true);
  });

  it('the same report fails the BLOG standard, which is why mode has to be passed', () => {
    expect(check(REPORT, 'blog', 'experience_markers')!.ok).toBe(false);
    expect(check(REPORT, 'blog', 'reporter_voice')).toBeUndefined();
  });

  it('flags first person in a report as the defect it is', () => {
    const withI = REPORT + '<p>I think the deadline is too tight, and we have seen this before.</p>';
    const r = check(withI, 'news', 'reporter_voice')!;
    expect(r.ok).toBe(false);
    expect(r.findings.join(' ')).toContain('third person');
  });

  it('measures attribution density instead', () => {
    const a = check(REPORT, 'news', 'attribution')!;
    expect(a.ok).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(4);
    // Honest about what it can and cannot do.
    expect(a.detail).toContain('cannot verify a source exists');
  });

  it('counts vague attribution against the report, not for it', () => {
    const vague =
      '<p>Experts say the rules are strict. Reports suggest lenders will struggle. It is understood the deadline may slip.</p>'.repeat(3);
    const a = check(vague, 'news', 'attribution')!;
    expect(a.ok).toBe(false);
    expect(a.findings.join(' ')).toMatch(/vague attribution/i);
  });

  it('does not run the attribution check on a blog post', () => {
    expect(check(REPORT, 'blog', 'attribution')).toBeUndefined();
  });
});
