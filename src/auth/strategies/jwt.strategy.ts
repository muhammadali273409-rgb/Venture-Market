import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { AppConfiguration } from '../../config/configuration';
import { AuthenticatedUser } from '../types/authenticated-user.type';
import { SOCKET_TOKEN_TYPE } from '../socket-token';

export interface JwtPayload {
  sub: string;
  email: string;
  role: AuthenticatedUser['role'];
}

function extractFromCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.access_token ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService<AppConfiguration, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractFromCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get('auth', { infer: true }).jwtSecret,
    });
  }

  validate(payload: JwtPayload & { typ?: string }): AuthenticatedUser {
    // Socket handshake tokens share the signing secret but must never act as access tokens.
    if (payload.typ === SOCKET_TOKEN_TYPE) {
      throw new UnauthorizedException();
    }
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
