import { describe, expect, it } from 'vitest';
import { extensionFor, inspectImage } from '../../../src/plugins/images/inspect.js';

/**
 * A real PNG header, not a fixture that merely claims to be one.
 *
 * The whole point of this module is that it reads the BYTES rather than
 * trusting a filename or a provider's own mime claim, so a test that fed it a
 * hand-waved buffer would be testing nothing. Signature, then an IHDR chunk
 * whose length and type are where a decoder expects them.
 */
function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}

/**
 * A JPEG with a real segment chain: SOI, then an APP0/JFIF segment, then the
 * SOF0 frame header. The intervening segment matters — dimensions do NOT sit
 * at a fixed offset in a JPEG, and a parser that assumes they do works on
 * exactly the files that have no EXIF or ICC data.
 */
function jpeg(width: number, height: number, { marker = 0xc0 } = {}): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(16, 0);
      return b;
    })(),
    Buffer.alloc(14),
  ]);
  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(marker, 1);
  sof.writeUInt16BE(8, 2); // segment length
  sof.writeUInt8(8, 4); // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([soi, app0, sof]);
}

describe('inspectImage', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    const info = inspectImage(png(1344, 768));
    expect(info.format).toBe('png');
    expect(info.mime).toBe('image/png');
    expect(info.width).toBe(1344);
    expect(info.height).toBe(768);
  });

  it('reads JPEG dimensions past an intervening APP0 segment', () => {
    const info = inspectImage(jpeg(1344, 768));
    expect(info.format).toBe('jpeg');
    expect(info.mime).toBe('image/jpeg');
    expect(info.width).toBe(1344);
    expect(info.height).toBe(768);
  });

  // Progressive JPEG is SOF2, not SOF0. A parser that only matched SOF0 would
  // silently report null dimensions for every progressive image.
  it('reads a progressive JPEG (SOF2) as well as a baseline one', () => {
    const info = inspectImage(jpeg(800, 600, { marker: 0xc2 }));
    expect(info.width).toBe(800);
    expect(info.height).toBe(600);
  });

  it('identifies a GIF', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(4)]);
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    const info = inspectImage(gif);
    expect(info.format).toBe('gif');
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
  });

  // Format is certain from the RIFF container; dimensions are not parsed. It
  // must say so with null rather than inventing a number a caller would act on.
  it('identifies WebP but reports null dimensions rather than guessing', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'ascii'),
    ]);
    const info = inspectImage(webp);
    expect(info.format).toBe('webp');
    expect(info.mime).toBe('image/webp');
    expect(info.width).toBeNull();
  });

  it('reports null for bytes that are not an image, and never throws', () => {
    for (const buf of [Buffer.alloc(0), Buffer.from('not an image'), Buffer.from([0xff, 0xd8])]) {
      const info = inspectImage(buf);
      expect(info.width).toBeNull();
      expect(info.height).toBeNull();
    }
    // A JPEG signature with no frame header is recognised as a JPEG but has no
    // dimensions to report — format known, size unknown, neither fabricated.
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff])).format).toBe('jpeg');
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff])).width).toBeNull();
  });

  it('always reports the byte length', () => {
    expect(inspectImage(Buffer.alloc(1234)).bytes).toBe(1234);
  });

  // Truncated files are exactly what a half-written or rate-limited download
  // leaves behind, and they must not crash the batch.
  it('survives a truncated PNG header', () => {
    const info = inspectImage(png(100, 100).subarray(0, 14));
    expect(info.format).toBe('png');
    expect(info.width).toBeNull();
  });
});

describe('extensionFor', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/avif', 'avif'],
  ])('maps %s to .%s', (mime, ext) => {
    expect(extensionFor(mime)).toBe(ext);
  });

  it('tolerates a charset parameter and odd casing', () => {
    expect(extensionFor('IMAGE/JPEG; charset=binary')).toBe('jpg');
  });

  // The defect this closes: every generated file was written `.png` regardless
  // of what the provider returned, and both adapters derive the upload
  // Content-Type from the extension — so a Gemini JPEG was uploaded declaring
  // itself a PNG. An unknown mime must NOT silently become `.png` again.
  it('does not fall back to png for an unknown or missing mime', () => {
    expect(extensionFor(undefined)).toBe('bin');
    expect(extensionFor(null)).toBe('bin');
    expect(extensionFor('application/octet-stream')).toBe('bin');
  });
});
