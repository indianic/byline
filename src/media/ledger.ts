import type { UsageLedger, UsageRecord } from './types.js';

/**
 * Has this asset been used?
 *
 * Both `reserved` and `published` count. A reservation means the bytes are
 * already on the platform, so serving the asset again would put the same
 * photograph in two posts — which is the one thing this ledger exists to stop.
 * Over-excluding is the recoverable direction; a duplicate on two live posts
 * is not.
 *
 * "Recoverable" is doing less work in THIS RELEASE than it looks: `release`
 * below has no production caller, so a reservation whose `create_post` failed
 * cannot be cleared through any tool or command. The remedy today is editing
 * the ledger JSON by hand — `list_media_libraries` reports the count and names
 * the file. Exposing `release` is Plan 2.
 */
export function isUsed(
  ledger: UsageLedger,
  id: string,
  site: string,
  scope: 'site' | 'global',
): boolean {
  return ledger.records.some((r) => r.id === id && (scope === 'global' || r.site === site));
}

/** Record an upload. Returns a new ledger; the input is untouched. */
export function reserve(ledger: UsageLedger, rec: Omit<UsageRecord, 'state'>): UsageLedger {
  return { ...ledger, records: [...ledger.records, { ...rec, state: 'reserved' }] };
}

/**
 * Confirm every reservation whose hosted URL made it into a published post.
 *
 * Matching on the hosted URL rather than threading ids through `create_post` is
 * deliberate: the URL is what actually appears in the published HTML, so this
 * confirms what the platform really stored rather than what the caller intended
 * it to store.
 *
 * Already-published records are left alone, so re-running `update_post` on an
 * article does not rewrite the URL of the post that first published an asset.
 */
export function promote(
  ledger: UsageLedger,
  hostedUrls: string[],
  postUrl: string,
): { ledger: UsageLedger; promoted: number } {
  const wanted = new Set(hostedUrls);
  let promoted = 0;

  const records = ledger.records.map((r) => {
    if (r.state !== 'reserved' || !wanted.has(r.hosted_url)) return r;
    promoted += 1;
    return { ...r, state: 'published' as const, post_url: postUrl };
  });

  return { ledger: { ...ledger, records }, promoted };
}

/**
 * Clear a reservation that never became a post.
 *
 * NO TOOL, AND NO CLI COMMAND, CALLS THIS in the current release — it is
 * exported and tested, and nothing in `src/tools/` or `src/cli/` reaches it.
 * A user whose publish failed after `use_media` succeeded clears the
 * reservation by editing the ledger file by hand; `list_media_libraries`
 * reports the count and names the path. Do not describe `release` to a user
 * as though it were reachable.
 *
 * Refuses to touch a `published` record. Releasing one would put an asset that
 * is live on a real page back into the unused pool, and the next article would
 * quietly reuse it.
 */
export function release(ledger: UsageLedger, id: string): { ledger: UsageLedger; released: number } {
  const kept = ledger.records.filter((r) => !(r.id === id && r.state === 'reserved'));
  return { ledger: { ...ledger, records: kept }, released: ledger.records.length - kept.length };
}

/**
 * Reservations that never became a post.
 *
 * Reported by `list_media_libraries` so an upload whose publish failed is
 * visible rather than a photograph that mysteriously stopped appearing in
 * search results.
 */
export function staleReservations(ledger: UsageLedger): UsageRecord[] {
  return ledger.records.filter((r) => r.state === 'reserved');
}
