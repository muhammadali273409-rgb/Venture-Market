import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { AppConfiguration } from '../config/configuration';

/** RFC 6266: ASCII fallback plus the exact UTF-8 name (e.g. Cyrillic file names). */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly serverSideEncryption?: ServerSideEncryption;
  readonly signedUrlTtlSeconds: number;

  constructor(private readonly configService: ConfigService<AppConfiguration, true>) {
    const storage = this.configService.get('storage', { infer: true });
    this.bucket = storage.bucket;
    this.signedUrlTtlSeconds = storage.signedUrlTtlSeconds;
    // Cloudflare R2 encrypts every object at rest on its own — leave
    // STORAGE_SSE empty there. On AWS S3 set it to AES256 (or aws:kms).
    this.serverSideEncryption = (storage.serverSideEncryption || undefined) as
      ServerSideEncryption | undefined;
    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: storage.forcePathStyle,
      credentials: {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      },
    });
  }

  buildObjectKey(businessId: string, fileName: string): string {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `businesses/${businessId}/documents/${nanoid()}-${safeName}`;
  }

  buildImageKey(businessId: string, fileName: string): string {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `businesses/${businessId}/images/${nanoid()}-${safeName}`;
  }

  async putObject(key: string, body: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        ...(this.serverSideEncryption ? { ServerSideEncryption: this.serverSideEncryption } : {}),
      }),
    );
  }

  /**
   * Short-lived URL (STORAGE_SIGNED_URL_TTL_SECONDS) — the bucket itself stays
   * private. `downloadAs` forces a file download under that name instead of
   * the browser rendering the file inline.
   */
  async getSignedDownloadUrl(key: string, options: { downloadAs?: string } = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.downloadAs
        ? { ResponseContentDisposition: contentDisposition(options.downloadAs) }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: this.signedUrlTtlSeconds });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
