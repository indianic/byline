/**
 * What a generated image actually IS, read from its own bytes.
 *
 * Two things made this necessary, both measured rather than reasoned about.
 *
 * `generate_image` wrote every file as `.png` regardless of what the provider
 * returned, and Gemini returns JPEG for some prompts (`inlineData.mimeType` is
 * whatever it chose). Both adapters derive the upload `Content-Type` from the
 * FILENAME EXTENSION — `mimeFor` in the WordPress adapter, `IMAGE_MIME` in the
 * Ghost one — so a JPEG saved as `.png` was uploaded declaring itself PNG. It
 * happened to work; it was never verified to, and nothing in the pipeline could
 * have noticed.
 *
 * And callers were reading whole PNGs back through a vision model purely to
 * confirm the dimensions were what they asked for. That is an expensive way to
 * read two 32-bit integers that sit at a fixed offset in the file.
 *
 * Honest about its limits: PNG and JPEG dimensions are parsed properly because
 * those are what the configured providers emit. GIF is trivial and included.
 * Anything else reports its format where the magic bytes are unambiguous and
 * `null` dimensions — never a guess. A fabricated dimension would be worse than
 * no dimension, because a caller would act on it.
 */

export interface ImageInfo {
  /** Lowercase format id from the magic bytes, or `null` when unrecognised. */
  format: 'png' | 'jpeg' | 'gif' | 'webp' | null;
  /** The mime implied by `format`, or `null`. Never taken from a filename. */
  mime: string | null;
  /** Pixel width, or `null` when this format's dimensions are not parsed. */
  width: number | null;
  height: number | null;
  bytes: number;
}

const MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

/** The canonical file extension for a mime, so a file is named what it is. */
export function extensionFor(mime: string | null | undefined): string {
  switch ((mime ?? '').toLowerCase().split(';')[0]!.trim()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/avif':
      return 'avif';
    default:
      // Not a silent default to `.png`: an unknown mime gets a neutral
      // extension so nothing downstream reads a format claim out of the name
      // that was never established.
      return 'bin';
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * JPEG frame markers that carry the image dimensions.
 *
 * Every SOFn except the four that are not frame headers: `FFC4` (define Huffman
 * table), `FFC8` (reserved), `FFCC` (define arithmetic coding conditioning) and
 * `FFD8`/`FFD9`. Listing the valid ones explicitly rather than excluding the
 * invalid ones keeps a future misreading from treating a Huffman table's length
 * bytes as a width.
 */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function pngSize(buf: Buffer): { width: number; height: number } | null {
  // 8-byte signature, 4-byte chunk length, 4-byte "IHDR", then width and height.
  if (buf.length < 24) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  // Walk the segment chain rather than assuming SOF0 sits at a fixed offset —
  // it does not; EXIF and ICC segments routinely precede it.
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    // Padding and standalone markers carry no length word.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      // marker(2) + length(2) + precision(1) => height, then width.
      if (i + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function gifSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** Read format and dimensions out of the bytes themselves. Never throws. */
export function inspectImage(data: Buffer): ImageInfo {
  const bytes = data.length;
  const none: ImageInfo = { format: null, mime: null, width: null, height: null, bytes };

  if (bytes >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const size = pngSize(data);
    return { format: 'png', mime: MIME_BY_FORMAT.png, width: size?.width ?? null, height: size?.height ?? null, bytes };
  }
  if (bytes >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const size = jpegSize(data);
    return { format: 'jpeg', mime: MIME_BY_FORMAT.jpeg, width: size?.width ?? null, height: size?.height ?? null, bytes };
  }
  if (bytes >= 6 && data.subarray(0, 4).toString('ascii') === 'GIF8') {
    const size = gifSize(data);
    return { format: 'gif', mime: MIME_BY_FORMAT.gif, width: size?.width ?? null, height: size?.height ?? null, bytes };
  }
  if (
    bytes >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    // Format is certain from the container; dimensions live in one of three
    // different chunk layouts (VP8/VP8L/VP8X) and are not parsed here. Reported
    // as null rather than guessed — no configured provider emits WebP.
    return { format: 'webp', mime: MIME_BY_FORMAT.webp, width: null, height: null, bytes };
  }
  return none;
}
