import { BusinessImage, BusinessImageKind } from '@prisma/client';
import { StorageService } from '../storage/storage.service';

export interface SerializedBusinessImage {
  id: string;
  kind: BusinessImageKind;
  url: string;
  position: number;
}

/** Prisma `include` for a business's images in display order (logo first, then gallery). */
export const ORDERED_IMAGES = {
  orderBy: [{ kind: 'asc' as const }, { position: 'asc' as const }, { createdAt: 'asc' as const }],
};

/**
 * The bucket is private, so every image is returned as a short-lived signed
 * URL. Signing is a local HMAC computation — no network round-trip — so it's
 * fine to do per card on marketplace pages.
 */
export async function serializeImages(
  storage: StorageService,
  images: BusinessImage[] | undefined,
): Promise<SerializedBusinessImage[]> {
  if (!images || images.length === 0) return [];
  return Promise.all(
    images.map(async (image) => ({
      id: image.id,
      kind: image.kind,
      url: await storage.getSignedDownloadUrl(image.storageKey),
      position: image.position,
    })),
  );
}

/** Logo plus the first gallery image (the card cover), derived from serialized images. */
export function pickCardMedia(images: SerializedBusinessImage[]): {
  logoUrl: string | null;
  coverUrl: string | null;
} {
  return {
    logoUrl: images.find((i) => i.kind === 'LOGO')?.url ?? null,
    coverUrl: images.find((i) => i.kind === 'GALLERY')?.url ?? null,
  };
}
