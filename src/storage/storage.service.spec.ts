import { HttpException, HttpStatus } from '@nestjs/common';
import { StorageService } from './storage.service';

function setup() {
  const config = {
    get: () => ({
      endpoint: 'http://localhost:9000',
      region: 'auto',
      bucket: 'docs',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
      signedUrlTtlSeconds: 300,
      serverSideEncryption: '',
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new StorageService(config as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = jest.spyOn((service as any).client, 'send');
  return { service, send };
}

describe('StorageService', () => {
  it('turns an unreachable storage host into 503 STORAGE_UNAVAILABLE', async () => {
    const { service, send } = setup();
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), {
      code: 'ECONNREFUSED',
    });
    send.mockRejectedValue(new AggregateError([refused]));

    const error = await service
      .putObject('k', Buffer.from('x'), 'text/plain')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((error as HttpException).getResponse()).toEqual({
      error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is temporarily unavailable' },
    });
  });

  it('signs short-lived, private download URLs that force a download', async () => {
    const { service } = setup();
    const url = new URL(
      await service.getSignedDownloadUrl('businesses/b/documents/x.pdf', {
        downloadAs: 'Ҳисобот.pdf',
      }),
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
  });
});
