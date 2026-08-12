/**
 * Video is not uploaded — dropped as a goal entirely. Instead, an article embeds
 * video from a streaming provider by URL: YouTube, Vimeo, or Bunny Stream, as an
 * `<iframe>`.
 *
 * Pure URL logic only: no network, no filesystem. Verified by live probe
 * 2026-08-12 against the probed Ghost install and the probed WordPress install
 * (account holding `unfiltered_html`) — see `docs/GHOST-NOTES.md` and
 * `docs/WORDPRESS-NOTES.md` for the request-by-request account, and
 * `src/plugins/platforms/ghost/html-profile.ts` /
 * `src/plugins/platforms/wordpress/html-profile.ts` for how that measurement is
 * encoded into what `score_draft` accepts.
 *
 * The one thing that silently fails otherwise: a `watch?v=` URL does NOT work
 * inside an `<iframe>` — the provider serves an HTML page, not embeddable
 * content, so `parseVideoUrl` always normalises to the embeddable form before
 * anything downstream ever sees the URL.
 */
import { ToolError } from '../errors.js';

export type EmbedProvider = 'youtube' | 'vimeo' | 'bunny';

export interface VideoEmbed {
  provider: EmbedProvider;
  /** The normalised, embeddable URL — always what actually works inside an <iframe>. */
  embedUrl: string;
  /** The URL as given, kept for messages and for anything that wants to show provenance. */
  sourceUrl: string;
}

const PROVIDER_LABEL: Record<EmbedProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  bunny: 'Bunny Stream',
};

/**
 * Refuses. Named for what it is, not what it does: every call site here is a
 * URL that failed to match any supported provider's shape, and this is the one
 * place that turns that into a `ToolError` — so the message and the hint (the
 * full provider list, so a caller does not have to guess the accepted forms)
 * cannot drift between the YouTube, Vimeo, and Bunny branches.
 *
 * This is the guard against "if it looks like a URL, pass it through": nothing
 * in this file ever emits an `<iframe>` pointing at a host that did not match
 * one of the three provider shapes below.
 */
function unsupported(url: string): never {
  throw new ToolError({
    api: 'embed_video',
    code: 'UNSUPPORTED_VIDEO_URL',
    message: `"${url}" is not a recognised YouTube, Vimeo, or Bunny Stream URL.`,
    hint:
      'Supported forms — YouTube: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID, youtube.com/embed/ID. ' +
      'Vimeo: vimeo.com/ID, vimeo.com/channels/NAME/ID, player.vimeo.com/video/ID. ' +
      'Bunny Stream: iframe.mediadelivery.net/embed/LIBRARY/GUID or /play/LIBRARY/GUID.',
  });
}

/**
 * A YouTube `t=`/`start=` value in seconds. Accepts a bare integer ("90") or
 * YouTube's own `1h2m3s`-style duration ("1m30s", "90s"). Returns null for
 * anything else rather than guessing — an unparsed value is dropped from the
 * embed URL instead of being forwarded as garbage.
 */
function parseSeconds(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return h * 3600 + min * 60 + s;
}

/**
 * A YouTube video id: exactly what YouTube itself generates — 11 URL-safe
 * base64-alphabet characters in practice, but this is deliberately looser
 * (6–32) to tolerate future id-length changes without becoming a taint path.
 * `u.searchParams.get('v')` returns a URL-DECODED value (unlike `u.pathname`,
 * which stays percent-encoded), so the `watch?v=` branch is the one place a
 * quote character can reach this file un-encoded — this is what stops it
 * before it ever becomes part of an embed URL.
 */
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

function youtubeEmbed(u: URL, raw: string): VideoEmbed {
  const host = u.hostname.replace(/^(www\.|m\.)/, '');
  let id: string | null = null;

  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0] || null;
  } else if (host === 'youtube.com') {
    if (u.pathname === '/watch') {
      id = u.searchParams.get('v');
    } else if (u.pathname.startsWith('/shorts/')) {
      id = u.pathname.slice('/shorts/'.length).split('/')[0] || null;
    } else if (u.pathname.startsWith('/embed/')) {
      id = u.pathname.slice('/embed/'.length).split('/')[0] || null;
    }
  }

  if (!id || !YOUTUBE_ID_PATTERN.test(id)) unsupported(raw);

  const tRaw = u.searchParams.get('t') ?? u.searchParams.get('start');
  const seconds = tRaw !== null ? parseSeconds(tRaw) : null;

  return {
    provider: 'youtube',
    embedUrl: `https://www.youtube.com/embed/${id}${seconds !== null && seconds > 0 ? `?start=${seconds}` : ''}`,
    sourceUrl: raw,
  };
}

/**
 * A Vimeo video id: Vimeo's ids are purely numeric, on every URL shape this
 * file accepts (bare, `channels/NAME/ID`, and `player.vimeo.com/video/ID`).
 * Applied to all three branches below, not only the bare one — `u.pathname`
 * stays percent-encoded today so none of them is exploitable yet, but an id
 * read from `pathname` here is one future `searchParams`-based refactor away
 * from being the same taint path YouTube's `?v=` was.
 */
const VIMEO_ID_PATTERN = /^\d+$/;

function vimeoEmbed(u: URL, raw: string): VideoEmbed {
  const host = u.hostname.replace(/^(www\.|m\.)/, '');
  const segments = u.pathname.split('/').filter(Boolean);
  let id: string | null = null;

  if (host === 'player.vimeo.com') {
    if (segments[0] === 'video' && segments[1]) id = segments[1];
  } else if (host === 'vimeo.com') {
    if (segments[0] === 'channels' && segments.length >= 3) {
      id = segments[segments.length - 1] ?? null;
    } else if (segments.length === 1 && VIMEO_ID_PATTERN.test(segments[0]!)) {
      id = segments[0]!;
    }
  }

  if (!id || !VIMEO_ID_PATTERN.test(id)) unsupported(raw);
  return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${id}`, sourceUrl: raw };
}

/** A Bunny Stream library id: purely numeric, as Bunny assigns it. */
const BUNNY_LIBRARY_PATTERN = /^\d+$/;
/** A Bunny Stream video GUID: Bunny's own GUID alphabet, hyphenated hex. */
const BUNNY_GUID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function bunnyEmbed(u: URL, raw: string): VideoEmbed {
  const segments = u.pathname.split('/').filter(Boolean);
  // /embed/LIBRARY/GUID or /play/LIBRARY/GUID — exactly three segments, either form.
  if (segments.length !== 3 || (segments[0] !== 'embed' && segments[0] !== 'play')) unsupported(raw);
  const [, library, guid] = segments;
  if (!library || !BUNNY_LIBRARY_PATTERN.test(library) || !guid || !BUNNY_GUID_PATTERN.test(guid)) {
    unsupported(raw);
  }
  return {
    provider: 'bunny',
    // Always the /embed/ form, per the measured behaviour — /play/ is normalised
    // to it rather than passed through, since only /embed/ was probed live.
    embedUrl: `https://iframe.mediadelivery.net/embed/${library}/${guid}`,
    sourceUrl: raw,
  };
}

/**
 * Normalise any supported provider URL to the form that actually works inside
 * an `<iframe>`, or throw a `ToolError` naming the URL and listing the
 * supported providers.
 *
 * Rejects anything not `https:` outright — no exception for a provider that
 * "would probably still work" over `http:`. Rejects anything whose host does
 * not match one of the three provider shapes, with no fallback that would
 * pass an unrecognised URL through as-is: a guard satisfiable by any
 * non-empty string is not a guard.
 */
export function parseVideoUrl(url: string): VideoEmbed {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return unsupported(url);
  }

  if (u.protocol !== 'https:') {
    throw new ToolError({
      api: 'embed_video',
      code: 'INSECURE_VIDEO_URL',
      message: `"${url}" is not an https URL. Only https video sources are embedded.`,
      hint: 'Use the https:// form of the link.',
    });
  }

  const host = u.hostname.replace(/^(www\.|m\.)/, '');
  if (host === 'youtube.com' || host === 'youtu.be') return youtubeEmbed(u, url);
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return vimeoEmbed(u, url);
  if (host === 'iframe.mediadelivery.net') return bunnyEmbed(u, url);
  return unsupported(url);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The exact markup measured to survive both platforms (see the module doc
 * comment): a `<figure><iframe ...></iframe></figure>`, with a `<figcaption>`
 * appended only when a caption was given — an empty `<figcaption></figcaption>`
 * was never probed and is not emitted.
 *
 * Every tag is written on one line with no line break inside it: Ghost's
 * converter is whitespace-sensitive inside a tag in ways the rest of this
 * codebase has already been burned by (see `GHOST_HTML_PROFILE`'s notes on
 * `<blockquote>` and `<figure><img>`), so this follows the same rule as
 * everywhere else HTML is generated here.
 */
export function embedHtml(e: VideoEmbed, caption?: string, title?: string): string {
  const trimmedTitle = title?.trim();
  const t = escapeHtml(trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : `${PROVIDER_LABEL[e.provider]} video`);
  const iframe = `<iframe src="${escapeHtml(e.embedUrl)}" width="560" height="315" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen title="${t}"></iframe>`;
  const trimmedCaption = caption?.trim();
  return trimmedCaption && trimmedCaption.length > 0
    ? `<figure>${iframe}<figcaption>${escapeHtml(trimmedCaption)}</figcaption></figure>`
    : `<figure>${iframe}</figure>`;
}
