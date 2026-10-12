import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { SOCKET_TOKEN_TYPE } from '../socket-token';

describe('JwtStrategy.validate', () => {
  const configService = { get: () => ({ jwtSecret: 'test-secret' }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strategy = new JwtStrategy(configService as any);

  it('accepts an access token payload', () => {
    expect(strategy.validate({ sub: 'u1', email: 'a@example.com', role: 'BUYER' })).toEqual({
      id: 'u1',
      email: 'a@example.com',
      role: 'BUYER',
    });
  });

  it('refuses a socket handshake token, so it can never call the REST API', () => {
    expect(() =>
      strategy.validate({
        sub: 'u1',
        email: undefined as unknown as string,
        role: undefined as unknown as 'BUYER',
        typ: SOCKET_TOKEN_TYPE,
      }),
    ).toThrow(UnauthorizedException);
  });
});
