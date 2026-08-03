import { intro, outro } from '@clack/prompts';
import { loadContext } from '../context.js';
import { checkEnvPermissions } from '../config/dotenv.js';
import { makeAdapter } from '../plugins/registry.js';
import { providerFamilies } from '../plugins/providers.js';
import { getPackageVersion } from '../version.js';
import { collectStatus } from './status.js';
import { attention, check, detail, section } from './tree.js';

/**
 * `doctor` — probe everything and print a fix per failure.
 *
 * Never gated, and never throws: this is the command someone runs when nothing
 * works, so it has to produce a useful answer in exactly that state. Every
 * failure row is paired with the specific action that resolves it, because a
 * diagnostic that says "Ghost unreachable" and stops has told the user only
 * what they already knew.
 *
 * `--offline` skips every network probe, for a fast config-only run.
 */

const MIN_NODE_MAJOR = 20;

interface Row {
  ok: boolean;
  text: string;
  /** The specific action that fixes this. Printed under the row. */
  fix?: string;
}

export async function runDoctor(args: string[]): Promise<void> {
  const offline = args.includes('--offline');
  intro(`byline — doctor (v${getPackageVersion()})`);

  const ctx = loadContext();
  const status = collectStatus(ctx);
  const rows: Row[] = [];

  // --- environment ---
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  rows.push({
    ok: nodeMajor >= MIN_NODE_MAJOR,
    text: `Node v${process.versions.node}`,
    ...(nodeMajor >= MIN_NODE_MAJOR
      ? {}
      : { fix: `byline needs Node >= ${MIN_NODE_MAJOR}. Switch with \`nvm use ${MIN_NODE_MAJOR}\` and re-run.` }),
  });

  section('environment');
  for (const r of rows) {
    check(r.ok, r.text);
    if (r.fix) attention(r.fix);
  }

  // --- where config came from ---
  // Per FIELD, not one global source: with a BYLINE_* override set, a
  // single "source" line describes the base and misdescribes the files.
  section(`paths   (base resolved from: ${status.baseSource})`);
  if (ctx.paths.source === 'repo') {
    attention(
      `Configuration is being read from the repo checkout at ${ctx.paths.home}, because ${ctx.paths.configFile} exists in the current directory and ~/.byline/ does not.\n` +
        'This branch is cwd-dependent and your AI tool chooses the cwd it launches the server in — so the server may see different config than this terminal does.\n' +
        'Run `byline migrate` to move this configuration into ~/.byline/, where it is found regardless of cwd.',
    );
  }
  for (const row of status.paths) {
    const origin = row.via ? `${row.source} via ${row.via}` : row.source;
    detail(`${row.label.padEnd(9)} ${row.path}   [${origin}]`);
  }

  // --- secrets file ---
  section('secrets');
  const permission = checkEnvPermissions(ctx.paths.envFile);
  if (permission) {
    check(false, `${ctx.paths.envFile} permissions`);
    attention(permission);
  } else {
    check(true, `${ctx.paths.envFile} is owner-only (or absent)`);
  }

  // --- config problems ---
  if (status.problems.length > 0) {
    section('config');
    for (const problem of status.problems) attention(problem);
  }

  // --- live blog probes ---
  section('blogs');
  const siteRows: Row[] = [];
  if (status.sites.length === 0) {
    // Config-only, so this applies even under --offline: publishing is the
    // entire point of the tool, and with no sites there is nothing it can do.
    detail('none configured — run `byline init`');
    siteRows.push({
      ok: false,
      text: 'no sites configured',
      fix: 'Nothing can be published without at least one site. Run `byline init` to add one.',
    });
  } else if (offline) {
    detail('skipped (--offline)');
  } else {
    for (const site of Object.values(ctx.sites.sites)) {
      if (site.unavailable) {
        siteRows.push({
          ok: false,
          text: `${site.slug} (${site.platform})`,
          fix: `${site.unavailable}\nAdd it to ${ctx.paths.envFile}, then restart your AI tool.`,
        });
        continue;
      }
      try {
        const health = await makeAdapter(site).healthCheck();
        siteRows.push({
          ok: health.ok,
          text: `${site.slug} (${site.platform}) — ${health.detail}`,
          ...(health.ok
            ? {}
            : {
                fix:
                  health.status === 401 || health.status === 403
                    ? `Credentials for "${site.slug}" were rejected. Re-run \`byline init\` to re-enter them, or fix the value in ${ctx.paths.envFile}.`
                    : health.status === 404
                      ? `The API was not found at ${site.apiUrl}. Many installs serve it on a different host or path — set \`api_url\` for "${site.slug}" in ${ctx.paths.configFile}.`
                      : `Check that ${site.url} is reachable from this machine, then re-run \`byline doctor\`.`,
              }),
        });
      } catch (e) {
        siteRows.push({
          ok: false,
          text: `${site.slug} (${site.platform})`,
          fix: `${e instanceof Error ? e.message : String(e)}\nCheck that ${site.url} is reachable from this machine.`,
        });
      }
    }
  }
  for (const r of siteRows) {
    check(r.ok, r.text);
    if (r.fix) attention(r.fix);
  }

  // --- live provider probes, one section per family ---
  //
  // No family is named here. The section heading and the wording for a skipped
  // provider both come off the family descriptor, because the old copy — "the
  // second provider is a fallback most users skip" — is true for images and
  // false for research.
  const providerRows: Row[] = [];
  for (const family of providerFamilies()) {
    section(family.label);
    if (offline) {
      detail('skipped (--offline)');
      continue;
    }
    const familyRows: Row[] = [];
    for (const provider of family.providers(ctx.env)) {
      if (!provider.configured()) {
        detail(
          `${provider.name.padEnd(9)} not configured (${provider.credential.name} unset) — ${family.unconfiguredNote}. ${provider.credential.help}`,
        );
        continue;
      }
      try {
        const health = await provider.healthCheck();
        familyRows.push({
          ok: health.ok,
          text: `${provider.name} — ${health.detail}`,
          ...(health.ok
            ? {}
            : { fix: `Replace ${provider.credential.name} in ${ctx.paths.envFile}. ${provider.credential.help}` }),
        });
      } catch (e) {
        familyRows.push({
          ok: false,
          text: provider.name,
          fix: `${e instanceof Error ? e.message : String(e)}\nReplace ${provider.credential.name} in ${ctx.paths.envFile}. ${provider.credential.help}`,
        });
      }
    }
    for (const r of familyRows) {
      check(r.ok, r.text);
      if (r.fix) attention(r.fix);
    }
    providerRows.push(...familyRows);
  }
  // `generate_image` specifically refuses with no image provider — a
  // targeted warning keyed off `status.imageProviders` (already
  // images-specific by name, computed in status.ts), not off a family id
  // branch here.
  if (!offline && status.imageProviders.every((p) => !p.configured)) {
    attention('No image provider is configured, so `generate_image` will refuse. Run `byline init` to add a key.');
  }

  // --- registrations ---
  section('AI tools');
  for (const r of status.registrations) {
    // The file alone no longer disambiguates: for Claude Code, `r.file` can be
    // ~/.claude.json for BOTH a global registration and a project-scoped one
    // stored inside it under `projects[<cwd>]` — `scope` is what tells them
    // apart (Finding 4).
    check(r.registered, `${r.label.padEnd(13)} ${r.registered ? `${r.file} [${r.scope ?? 'global'}]` : 'not registered'}`);
  }
  const registrationRows: Row[] = [];
  if (status.registrations.every((r) => !r.registered)) {
    // A single unregistered tool is fine — a user who only wired up Cursor has
    // a working setup. Zero registered is total inoperability: no AI client
    // can reach byline at all, the same class of failure as a bad Node
    // version, so this one DOES contribute to allOk.
    registrationRows.push({
      ok: false,
      text: 'no AI tool registered',
      fix: 'No AI tool has byline registered. Run `byline register --tools all`, then restart the tool.',
    });
  }
  for (const r of registrationRows) {
    check(r.ok, r.text);
    if (r.fix) attention(r.fix);
  }

  const allOk = [...rows, ...siteRows, ...providerRows, ...registrationRows].every((r) => r.ok) && !permission;
  outro(allOk ? 'All checks passed.' : 'Some checks failed — each failure above names its fix.');
  if (!allOk) process.exitCode = 1;
}
