import type { PlatformPlugin } from '../plugins/platforms/types.js';

/**
 * Compose one site's `config.yaml` block from its platform's credential
 * descriptors.
 *
 * This is deliberately the ONLY place that decides how a credential lands in
 * the config file, because two callers need the identical rule — `add_site`
 * (an AI tool adding a site) and the CLI installer (a human at a prompt) — and
 * a second hand-written copy is exactly how the two would drift.
 *
 * The rule: a `secret` field is written as `${ENV_VAR}` and its value belongs
 * in `.env`; a non-secret field is written literally. That split is what keeps
 * `config.yaml` shareable and confines everything sensitive to one 0600 file.
 *
 * `envNames` is keyed by credential field name. For a secret field the value is
 * the NAME of the environment variable holding the real secret — never the
 * secret itself. For a non-secret field it is the value.
 */
export function buildSiteBlock(
  plugin: PlatformPlugin,
  url: string,
  envNames: Record<string, string>,
  defaultAuthor?: string,
): Record<string, string> {
  const block: Record<string, string> = {
    platform: plugin.id,
    url: url.replace(/\/+$/, ''),
  };
  for (const f of plugin.credentialFields) {
    const given = envNames[f.name]!;
    block[f.name] = f.secret ? `\${${given}}` : given;
  }
  if (defaultAuthor) block.default_author = defaultAuthor;
  return block;
}
