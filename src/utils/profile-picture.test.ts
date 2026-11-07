// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PROFILE_PICTURE_BYTES,
  detectProfileImageMimeType,
  prepareProfilePicture,
  profilePictureDataUrl,
  validateProfileImageFile,
  type IdentityProfilePicture
} from './profile-picture';

function pngChunk(type: string): Uint8Array {
  const chunk = new Uint8Array(12);
  new DataView(chunk.buffer).setUint32(0, 0, false);
  chunk.set(Array.from(type, (character) => character.charCodeAt(0)), 4);
  return chunk;
}

describe('profile picture image helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makePngFile(): File {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
    const file = new File([bytes], 'avatar.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
    return file;
  }

  function makeEncodedBlob(bytes: Uint8Array, mimeType: string): Blob {
    const data = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(data).set(bytes);
    const blob = new Blob([data], { type: mimeType });
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => data });
    return blob;
  }

  it('accepts supported static image signatures and rejects unsupported formats', () => {
    expect(detectProfileImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(detectProfileImageMimeType(new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]))).toBe('image/png');
    const webp = new Uint8Array(12);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    expect(detectProfileImageMimeType(webp)).toBe('image/webp');
    expect(detectProfileImageMimeType(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(detectProfileImageMimeType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it('rejects APNG and animated WebP content', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...pngChunk('acTL')
    ]);
    const webp = new Uint8Array(24);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    webp.set(new TextEncoder().encode('ANIM'), 12);

    expect(detectProfileImageMimeType(png)).toBeNull();
    expect(detectProfileImageMimeType(webp)).toBeNull();
  });

  it('only exposes well-formed 256px WebP/JPEG pictures within the encoded-size limit', () => {
    const valid: IdentityProfilePicture = {
      mime_type: 'image/webp',
      width: 256,
      height: 256,
      data: 'AQID'
    };
    expect(profilePictureDataUrl(valid)).toBe('data:image/webp;base64,AQID');
    expect(profilePictureDataUrl({
      ...valid,
      data: `${'A'.repeat(Math.ceil(MAX_PROFILE_PICTURE_BYTES / 3) * 4 - 1)}=`
    })).not.toBeNull();
    expect(profilePictureDataUrl({ ...valid, width: 128 })).toBeNull();
    expect(profilePictureDataUrl({ ...valid, mime_type: 'image/svg+xml' })).toBeNull();
    expect(profilePictureDataUrl({ ...valid, data: 'not base64!' })).toBeNull();
    expect(profilePictureDataUrl({
      ...valid,
      data: 'A'.repeat(Math.ceil(MAX_PROFILE_PICTURE_BYTES / 3) * 4 + 4)
    })).toBeNull();
  });

  it('uses the browser-decoded dimensions and rejects decode failures and oversized images', async () => {
    const png = makePngFile();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 480, close })));

    await expect(validateProfileImageFile(png)).resolves.toEqual({
      mimeType: 'image/png',
      width: 640,
      height: 480
    });
    expect(close).toHaveBeenCalledOnce();

    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
    await expect(validateProfileImageFile(png)).rejects.toThrow('could not be decoded');

    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10_000, height: 480, close })));
    await expect(validateProfileImageFile(png)).rejects.toThrow('dimensions are too large');

    const svg = new File(['<svg/>'], 'avatar.svg', { type: 'image/svg+xml' });
    Object.defineProperty(svg, 'arrayBuffer', { value: async () => new TextEncoder().encode('<svg/>').buffer });
    await expect(validateProfileImageFile(svg)).rejects.toThrow('valid, non-animated');
  });

  it('crops to 256 square pixels and reduces WebP quality to meet the payload limit', async () => {
    const drawImage = vi.fn();
    const qualities: number[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 640,
      height: 480,
      close: vi.fn()
    })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage }) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type, quality) => {
      qualities.push(quality ?? 1);
      const size = quality === 0.92 ? MAX_PROFILE_PICTURE_BYTES + 1 : 3;
      callback(makeEncodedBlob(new Uint8Array(size), type ?? ''));
    });

    const picture = await prepareProfilePicture(makePngFile(), { x: 1, y: 0.25, zoom: 2 });

    expect(qualities).toEqual([0.92, 0.84]);
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      400,
      60,
      240,
      240,
      0,
      0,
      256,
      256
    );
    expect(picture).toMatchObject({ mime_type: 'image/webp', width: 256, height: 256, data: 'AAAA' });
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 256,
      height: 256,
      close: vi.fn()
    })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: vi.fn() }) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => {
      callback(makeEncodedBlob(
        new Uint8Array([1, 2, 3]),
        type === 'image/webp' ? 'image/png' : 'image/jpeg'
      ));
    });

    await expect(prepareProfilePicture(makePngFile(), { x: 0.5, y: 0.5, zoom: 1 }))
      .resolves.toMatchObject({ mime_type: 'image/jpeg', width: 256, height: 256 });
  });
});
