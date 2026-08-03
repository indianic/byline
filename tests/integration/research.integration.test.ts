import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { BraveResearch } from '../../src/plugins/research/brave/index.js';
import { research } from '../../src/plugins/research/index.js';
import { TavilyResearch } from '../../src/plugins/research/tavily/index.js';

const live = process.env.RUN_INTEGRATION === '1';
const braveKey = process.env.BRAVE_API_KEY ?? '';
const tavilyKey = process.env.TAVILY_API_KEY ?? '';

// `describe.skipIf` still EXECUTES the suite callback to collect tests — it
// only marks the collected tests as skipped afterward (see
// ghost.integration.test.ts). So nothing that depends on a missing key may be
// constructed inside a callback body; the `new BraveResearch(braveKey)` /
// `new TavilyResearch(tavilyKey)` calls below are safe because the
// constructors accept an empty string without throwing (they only fail, or
// report unhealthy, when actually used) — but the guarding `describe.skipIf`
// on each inner block still exists so those calls are never reached with an
// empty key at all when the key is absent.
/**
 * Name a suite for what actually happened, not for what might have.
 *
 * A label baked as `'brave (skipped: BRAVE_API_KEY not set)'` prints verbatim
 * even when the key IS set and every test passed, so a reader of the output
 * sees `✓ brave (skipped: …) > accepts the real key` and cannot tell whether
 * anything ran. `ghost.integration.test.ts` gets this right by branching on the
 * reason; this does the same, in the one line a `skipIf` label allows.
 */
const suite = (key: string, name: string, envVar: string): string =>
  key ? name : `${name} — SKIPPED: ${envVar} not set`;

/** Same rule as `suite()`, for a block gated on more than one key. */
const suiteAll = (name: string, missingEnvVars: string[]): string =>
  missingEnvVars.length === 0 ? name : `${name} — SKIPPED: ${missingEnvVars.join(', ')} not set`;

describe.skipIf(!live)('research providers, live', () => {
  describe.skipIf(!braveKey)(suite(braveKey, 'brave', 'BRAVE_API_KEY'), () => {
    it('returns findings with real URLs for a current topic', async () => {
      const out = await new BraveResearch(braveKey).search('cricket', { window: 'day', maxResults: 5 });
      expect(out.findings.length).toBeGreaterThan(0);
      for (const f of out.findings) expect(f.url).toMatch(/^https?:\/\//);
      expect(out.answer).toBeUndefined(); // Brave never synthesizes
    });

    // The ADDING-A-PLATFORM.md step 4 gate, live. A mocked non-2xx proves the
    // adapter handles a 4xx; only this proves the endpoint requires auth at
    // all. Ghost's `healthCheck` probed `GET /site/`, which needs no auth — a
    // fabricated key returned 200 with the real site title, and `byline init`
    // accepted wrong keys for four phases. Measured 2026-07-30: 422.
    it('rejects a fabricated-but-well-formed key with a non-2xx', async () => {
      const health = await new BraveResearch('BSA' + 'a'.repeat(29)).healthCheck();
      expect(health.ok).toBe(false);
      expect(health.status).toBeGreaterThanOrEqual(400);
    });

    it('accepts the real key', async () => {
      expect((await new BraveResearch(braveKey).healthCheck()).ok).toBe(true);
    });

    // Everything above exercises `BraveResearch` directly. Nothing in this
    // file, before this test, ever called `research()` — the orchestrator in
    // src/plugins/research/index.ts that `research_topic` actually calls, and
    // that owns provider selection and the `selectedBy` reporting. This
    // proves an explicit `provider` live: the named provider runs, and the
    // result says why it was picked.
    it('runs brave via research() when named explicitly, reporting selectedBy: "explicit"', async () => {
      const out = await research('cricket', {
        window: 'day',
        maxResults: 5,
        provider: 'brave',
        env: { BRAVE_API_KEY: braveKey },
      });
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.provider).toBe('brave');
      expect(out.selectedBy).toBe('explicit');
    });
  });

  describe.skipIf(!tavilyKey)(suite(tavilyKey, 'tavily', 'TAVILY_API_KEY'), () => {
    it('returns findings, and — when Tavily can synthesize one — a non-empty answer', async () => {
      const out = await new TavilyResearch(tavilyKey).search('cricket', { window: 'day', maxResults: 5 });
      expect(out.findings.length).toBeGreaterThan(0);
      // Tavily can legitimately return no answer for a query it can't
      // synthesize that day (`include_answer: true` is not a promise of a
      // non-null `answer`), and our adapter omits `answer` entirely rather
      // than passing `null` through. Asserting `typeof out.answer ===
      // 'string'` therefore fails on days Tavily has nothing to synthesize,
      // for reasons unrelated to any regression. Pin the adapter's actual
      // contract instead: `answer` is either a non-empty string or entirely
      // absent — never `''`, never `null`, never a non-string. Logged, not
      // just asserted, so a human reading the run can see which outcome
      // happened today. The unit suite (tavily.test.ts) already pins that
      // `include_answer: true` is sent — the regression this assertion was
      // originally guarding — deterministically, where it can be checked
      // without depending on the live web.
      console.log(
        out.answer === undefined
          ? 'tavily answer: absent (nothing synthesized today)'
          : `tavily answer: synthesized (${out.answer.length} chars)`,
      );
      expect(out.answer === undefined || (typeof out.answer === 'string' && out.answer.length > 0)).toBe(true);
    });

    // Same auth-gate rationale as Brave above. Measured 2026-07-30: 401.
    it('rejects a fabricated-but-well-formed key with a non-2xx', async () => {
      const health = await new TavilyResearch('tvly-' + 'a'.repeat(32)).healthCheck();
      expect(health.ok).toBe(false);
      expect(health.status).toBeGreaterThanOrEqual(400);
    });

    it('accepts the real key', async () => {
      expect((await new TavilyResearch(tavilyKey).healthCheck()).ok).toBe(true);
    });

    // See the matching brave test above for why this exists.
    it('runs tavily via research() when named explicitly, reporting selectedBy: "explicit"', async () => {
      const out = await research('cricket', {
        window: 'day',
        maxResults: 5,
        provider: 'tavily',
        env: { TAVILY_API_KEY: tavilyKey },
      });
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.provider).toBe('tavily');
      expect(out.selectedBy).toBe('explicit');
    });
  });

  // The rest of `research()`'s contract that neither provider suite above can
  // exercise: what happens with NO explicit provider (registry order) and
  // what happens when a provider is named but unconfigured (the no-fallback
  // rule). Both are proven only against mocks elsewhere
  // (tests/plugins/research/select.test.ts) — this is the live counterpart.
  const orchestratorMissing = [!braveKey && 'BRAVE_API_KEY', !tavilyKey && 'TAVILY_API_KEY'].filter(
    (v): v is string => v !== false,
  );
  describe.skipIf(orchestratorMissing.length > 0)(
    suiteAll('research(), both providers configured, no explicit provider named', orchestratorMissing),
    () => {
      // Registry order is Brave-first, decided by measurement (see the doc
      // comment on `researchProviders` and docs/RESEARCH-NOTES.md), not by
      // preference. This is the live proof that order actually governs which
      // provider a caller gets when both are configured and none is pinned —
      // a flipped registry order, or a `selectedBy` that stopped saying why,
      // would only be caught here.
      it('picks brave by registry order and reports selectedBy: "registry-order"', async () => {
        const out = await research('cricket', {
          window: 'day',
          maxResults: 5,
          env: { BRAVE_API_KEY: braveKey, TAVILY_API_KEY: tavilyKey },
        });
        expect(out.findings.length).toBeGreaterThan(0);
        expect(out.provider).toBe('brave');
        expect(out.selectedBy).toBe('registry-order');
      });
    },
  );

  describe.skipIf(!braveKey && !tavilyKey)('research(), no-fallback rule, live', () => {
    // THE central rule of this phase, checked live for the first time: naming
    // a provider whose key is absent is refused, never silently answered by
    // the other configured provider (they return different shapes — see
    // `selectProvider`'s doc comment). `env` here is built with only the
    // present key, so the named provider is genuinely unconfigured from
    // `research()`'s point of view even during a both-keys run — this isn't
    // simulated against a mock, it's the real `selectProvider` + real
    // `ToolError` path.
    it('refuses a named provider whose key is absent, and returns no result', async () => {
      const [presentVar, presentVal, absentProvider] = braveKey
        ? (['BRAVE_API_KEY', braveKey, 'tavily'] as const)
        : (['TAVILY_API_KEY', tavilyKey, 'brave'] as const);

      let result: Awaited<ReturnType<typeof research>> | undefined;
      let error: unknown;
      try {
        result = await research('cricket', {
          window: 'day',
          provider: absentProvider,
          env: { [presentVar]: presentVal },
        });
      } catch (e) {
        error = e;
      }

      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe('RESEARCH_PROVIDER_UNCONFIGURED');
    });
  });

  // THE acceptance case. Not "the API accepts a freshness parameter" — that a
  // source published within the last day actually comes back, dated. Logs
  // the measured age rather than only asserting a loose bound, because that
  // number is the acceptance claim and a future run that degrades should say
  // by how much (see docs/RESEARCH-NOTES.md — Brave ~55min, Tavily ~4h39m on
  // the 2026-07-30 probe query). The bound here is intentionally loose (48h)
  // because news indexing genuinely varies run to run; it exists to catch
  // recency breaking entirely, not to pin today's exact figure.
  describe.skipIf(!braveKey && !tavilyKey)('recency, measured', () => {
    it('returns at least one source dated within the last 48 hours', async () => {
      const provider = tavilyKey ? new TavilyResearch(tavilyKey) : new BraveResearch(braveKey);
      const out = await provider.search('cricket match result', { window: 'day', maxResults: 10 });
      const dated = out.findings.filter((f) => f.publishedAt);
      expect(dated.length).toBeGreaterThan(0);
      const freshest = Math.max(...dated.map((f) => Date.parse(f.publishedAt!)));
      const ageHours = (Date.now() - freshest) / 3_600_000;
      // Logged, not just asserted: this number is the acceptance claim, and a
      // future run that degrades should say by how much.
      console.log(`freshest ${provider.name} result: ${ageHours.toFixed(1)}h old`);
      expect(ageHours).toBeLessThan(48);
    });
  });
});
