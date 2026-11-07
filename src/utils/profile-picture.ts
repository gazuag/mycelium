export const PROFILE_PICTURE_SIZE = 256;
export const MAX_PROFILE_PICTURE_BYTES = 50 * 1024;
const MAX_SOURCE_DIMENSION = 8192;
const MAX_SOURCE_PIXELS = 40_000_000;

export type ProfilePictureMimeType = 'image/webp' | 'image/jpeg';

export type IdentityProfilePicture = {
  readonly mime_type: ProfilePictureMimeType;
  readonly width: 256;
  readonly height: 256;
  readonly data: string;
};

export interface ProfilePictureCrop {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface ProfileImageInfo {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function detectProfileImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 12
    && readAscii(bytes, 0, 4) === 'RIFF'
    && readAscii(bytes, 8, 4) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkType = readAscii(bytes, offset, 4);
      const chunkLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset + 4, true);
      if (chunkType === 'ANIM' || chunkType === 'ANMF') return null;
      if (chunkType === 'VP8X' && offset + 8 < bytes.length && (bytes[offset + 8] & 0x02) !== 0) return null;
      offset += 8 + chunkLength + (chunkLength % 2);
    }
    return 'image/webp';
  }

  if (bytes.length >= 8
    && bytes[0] === 0x89
    && readAscii(bytes, 1, 3) === 'PNG'
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const chunkLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
      const chunkType = readAscii(bytes, offset + 4, 4);
      if (chunkType === 'acTL') return null;
      if (chunkLength > bytes.length - offset - 12) break;
      offset += chunkLength + 12;
    }
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  return null;
}

export async function validateProfileImageFile(file: File): Promise<ProfileImageInfo> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error('This image file could not be read.');
  }
  const mimeType = detectProfileImageMimeType(bytes);
  if (!mimeType) {
    throw new Error('Choose a valid, non-animated JPEG, PNG, or WebP image.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image could not be decoded. Choose a different image.');
  }

  const { width, height } = bitmap;
  bitmap.close();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION
    || width * height > MAX_SOURCE_PIXELS) {
    throw new Error('Image dimensions are too large to process safely.');
  }
  return { mimeType, width, height };
}

function normalizedCrop(crop: ProfilePictureCrop): ProfilePictureCrop {
  return {
    x: Math.min(1, Math.max(0, crop.x)),
    y: Math.min(1, Math.max(0, crop.y)),
    zoom: Math.min(3, Math.max(1, crop.zoom))
  };
}

function blobFromCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The browser could not encode the cropped image.'));
      }, type, quality);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('The browser could not encode the cropped image.'));
    }
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function prepareProfilePicture(
  file: File,
  crop: ProfilePictureCrop
): Promise<IdentityProfilePicture> {
  const info = await validateProfileImageFile(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image could not be decoded. Choose a different image.');
  }

  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
    canvas.width = PROFILE_PICTURE_SIZE;
    canvas.height = PROFILE_PICTURE_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable in this browser.');

    const selection = normalizedCrop(crop);
    const cropSize = Math.min(info.width, info.height) / selection.zoom;
    const sourceX = (info.width - cropSize) * selection.x;
    const sourceY = (info.height - cropSize) * selection.y;
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      cropSize,
      cropSize,
      0,
      0,
      PROFILE_PICTURE_SIZE,
      PROFILE_PICTURE_SIZE
    );
  } finally {
    bitmap.close();
  }

  const qualitySteps = [0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36, 0.28, 0.2, 0.12];
  for (const [mimeType, outputMimeType] of [
    ['image/webp', 'image/webp'],
    ['image/jpeg', 'image/jpeg']
  ] as const) {
    for (const quality of qualitySteps) {
      try {
        const blob = await blobFromCanvas(canvas, outputMimeType, quality);
        if (blob.type !== mimeType) break;
        if (blob.size > MAX_PROFILE_PICTURE_BYTES) continue;
        return {
          mime_type: mimeType,
          width: PROFILE_PICTURE_SIZE,
          height: PROFILE_PICTURE_SIZE,
          data: bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
        };
      } catch {
        break;
      }
    }
  }
  throw new Error('This image could not be encoded below the 50 KiB limit.');
}

export function isIdentityProfilePicture(value: unknown): value is IdentityProfilePicture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const picture = value as Partial<IdentityProfilePicture>;
  if ((picture.mime_type !== 'image/webp' && picture.mime_type !== 'image/jpeg')
    || picture.width !== PROFILE_PICTURE_SIZE
    || picture.height !== PROFILE_PICTURE_SIZE
    || typeof picture.data !== 'string'
    || picture.data.length === 0
    || picture.data.length > Math.ceil(MAX_PROFILE_PICTURE_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(picture.data)) {
    return false;
  }
  const padding = picture.data.endsWith('==') ? 2 : picture.data.endsWith('=') ? 1 : 0;
  const decodedSize = (picture.data.length / 4) * 3 - padding;
  return decodedSize <= MAX_PROFILE_PICTURE_BYTES;
}

export function profilePictureDataUrl(value: unknown): string | null {
  if (!isIdentityProfilePicture(value)) return null;
  return `data:${value.mime_type};base64,${value.data}`;
}
