import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { AppConfiguration } from '../config/configuration';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/constants/error-codes';

/** RFC 6266: ASCII fallback plus the exact UTF-8 name (e.g. Cyrillic file names). */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Private S3-compatible bucket (Cloudflare R2 in production, MinIO locally).
 * Files are only ever reached through short-lived signed URLs.
 */
@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly serverSideEncryption?: ServerSideEncryption;
  readonly signedUrlTtlSeconds: number;

  constructor(private readonly configService: ConfigService<AppConfiguration, true>) {
    const storage = this.configService.get('storage', { infer: true });
    this.bucket = storage.bucket;
    this.endpoint = storage.endpoint;
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
      // Fail fast instead of hanging an upload request when storage is unreachable.
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
    });
  }

  /** Non-fatal: tells the logs at boot whether the bucket is reachable with these credentials. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Storage OK: bucket "${this.bucket}" at ${this.endpoint}`);
    } catch (error) {
      this.logger.error(
        `Storage check FAILED for bucket "${this.bucket}" at ${this.endpoint} — uploads will return 503. ` +
          `Check STORAGE_ENDPOINT / STORAGE_BUCKET / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY. Cause: ${describe(error)}`,
      );
    }
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
    await this.send('upload', () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
          ...(this.serverSideEncryption ? { ServerSideEncryption: this.serverSideEncryption } : {}),
        }),
      ),
    );
  }

  /**
   * Short-lived URL (STORAGE_SIGNED_URL_TTL_SECONDS) — the bucket itself stays
   * private. `downloadAs` forces a file download under that name instead of
   * the browser rendering the file inline. Signing is local (no network call).
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
    await this.send('delete', () =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
    );
  }

  /**
   * Any storage failure (unreachable host, bad credentials, missing bucket)
   * is a 503 STORAGE_UNAVAILABLE for the client — the request itself was
   * fine — with the real cause in the logs.
   */
  private async send<T>(action: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.logger.error(
        `Storage ${action} failed (bucket "${this.bucket}" at ${this.endpoint}): ${describe(error)}`,
      );
      throw new AppException(
        ErrorCode.STORAGE_UNAVAILABLE,
        'File storage is temporarily unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}

/** ECONNREFUSED arrives as an AggregateError with an empty message — dig out the codes. */
function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describe).join('; ') || 'AggregateError';
  }
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return [error.name, code, error.message].filter(Boolean).join(' ');
  }
  return String(error);
}
