import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { AccountStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PasswordService } from './password.service';
import { generateOpaqueToken, hashOpaqueToken } from './token.service';
import { AppConfiguration } from '../config/configuration';
import { parseDurationMs } from '../common/utils/duration';
import { EmailService } from '../integrations/email/email.service';
import { AuditService } from '../common/audit/audit.service';
import { ErrorCode } from '../common/constants/error-codes';
import {
  ConflictAppException,
  ForbiddenAppException,
  UnauthorizedAppException,
} from '../common/errors/app.exception';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './strategies/jwt.strategy';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  // Stateless verifier — no client secret needed to *verify* an ID token,
  // only to validate its signature/issuer/audience/expiry against Google's
  // public keys. The audience (our client ID) is passed per-call below.
  private readonly googleClient = new OAuth2Client();

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfiguration, true>,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictAppException(
        ErrorCode.AUTH_EMAIL_TAKEN,
        'An account with this email already exists',
      );
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        // RegisterDto.role is validated (@IsIn(['BUYER','SELLER'])) and
        // whitelisted by the global ValidationPipe — no other value, e.g.
        // "ADMIN", can ever reach this line from a client request body.
        role: dto.role === 'BUYER' ? UserRole.BUYER : UserRole.SELLER,
        status: AccountStatus.PENDING_VERIFICATION,
        profile: {
          create: {
            firstName: dto.firstName,
            lastName: dto.lastName,
          },
        },
        notificationPreference: { create: {} },
      },
    });

    await this.issueEmailVerificationToken(user.id, user.email);
    await this.auditService.record({
      userId: user.id,
      action: 'USER_REGISTERED',
      targetType: 'User',
      targetId: user.id,
      ipAddress: meta.ipAddress,
    });

    return { id: user.id, email: user.email, status: user.status };
  }

  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ user: unknown; tokens: AuthTokens }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt) {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Invalid email or password',
      );
    }

    const valid = await this.passwordService.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Invalid email or password',
      );
    }

    if (user.status === AccountStatus.SUSPENDED || user.status === AccountStatus.DEACTIVATED) {
      throw new ForbiddenAppException(
        ErrorCode.AUTH_ACCOUNT_SUSPENDED,
        'This account is not active',
      );
    }

    const tokens = await this.issueTokenPair(user.id, user.email, user.role, meta);

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.auditService.record({
      userId: user.id,
      action: 'USER_LOGIN',
      targetType: 'User',
      targetId: user.id,
      ipAddress: meta.ipAddress,
    });

    return {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      tokens,
    };
  }

  /**
   * "Continue with Google" login/register. An existing VentureMarket account
   * (matched by the verified Google identity) signs straight in and its role
   * is never touched. For a verified Google identity with no existing
   * account, `role` (BUYER/SELLER only — enforced by GoogleLoginDto's
   * whitelist, "ADMIN" cannot reach this method) decides what gets created:
   * if it's missing, no account is created yet and the caller is told to
   * collect it (`needsRole: true`); once the frontend resubmits the same
   * verified credential with a role, the account is created with it. Google
   * only ever proves *who the person is* — it never grants a role by itself,
   * and Admin can only ever come from the separate, server-only bootstrap
   * script.
   */
  async loginWithGoogle(
    credential: string,
    role: 'BUYER' | 'SELLER' | undefined,
    meta: RequestMeta,
  ): Promise<{ user: unknown; tokens: AuthTokens | null; isNewUser: boolean; needsRole: boolean }> {
    const googleClientId = this.configService.get('google', { infer: true }).clientId;
    if (!googleClientId) {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_GOOGLE_TOKEN_INVALID,
        'Google sign-in is not configured',
      );
    }

    let payload: TokenPayload | undefined;
    try {
      // verifyIdToken cryptographically checks the signature against Google's
      // published keys, and validates issuer, audience (must equal our
      // client ID), and expiry. A tampered or foreign-audience token throws
      // here — nothing past this point ever runs on unverified input.
      const ticket = await this.googleClient.verifyIdToken({
        idToken: credential,
        audience: googleClientId,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_GOOGLE_TOKEN_INVALID,
        'Google authentication failed',
      );
    }

    // Google only asserts email ownership when email_verified is true —
    // without it, `email` is not proof of anything.
    if (!payload?.sub || !payload.email || !payload.email_verified) {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_GOOGLE_TOKEN_INVALID,
        'Google authentication failed',
      );
    }

    const googleId = payload.sub;
    const email = payload.email;

    // Match by the stable Google subject first; fall back to the verified
    // email only to bootstrap-link a pre-existing password account that has
    // never signed in with Google before. Both values come exclusively from
    // the verified token payload above — never from anything the client
    // could freely supply.
    let user = await this.prisma.user.findFirst({
      where: { deletedAt: null, OR: [{ googleId }, { email }] },
    });

    // Defense in depth: the email-fallback match above could only resolve to
    // a user already linked to a *different* Google subject if the same
    // verified email were somehow issued by two distinct Google accounts —
    // Google does not allow that, but refuse to log in rather than silently
    // re-link if it's ever observed.
    if (user && user.googleId && user.googleId !== googleId) {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_GOOGLE_ACCOUNT_MISMATCH,
        'This Google account does not match the existing VentureMarket account for this email.',
      );
    }

    let isNewUser = false;
    if (!user) {
      isNewUser = true;

      // No existing VentureMarket account for this verified Google identity,
      // and no role has been picked yet — hand back to the caller instead of
      // creating anything. Nothing is persisted here, so an abandoned/
      // cancelled onboarding leaves no trace (no user row, no session).
      if (!role) {
        return { user: null, tokens: null, isNewUser: true, needsRole: true };
      }

      // `role` is BUYER or SELLER only — GoogleLoginDto's @IsIn whitelist
      // (backed by the global ValidationPipe) rejects anything else,
      // including "ADMIN", before this method is ever called. This is the
      // ONLY place Google sign-in creates an account, and it can never
      // produce anything but a normal user. Admin is exclusively created by
      // the separate bootstrap script (prisma/scripts/bootstrap-admin.ts).
      //
      // passwordHash is a required column, but a Google-only account has no
      // password — fill it with an unrecoverable random value (never
      // returned, never logged) so password login simply fails until the
      // user sets a real password via "forgot password".
      const unusablePassword = await this.passwordService.hash(generateOpaqueToken().raw);

      user = await this.prisma.user.create({
        data: {
          email,
          googleId,
          passwordHash: unusablePassword,
          role: role === 'BUYER' ? UserRole.BUYER : UserRole.SELLER,
          status: AccountStatus.ACTIVE,
          emailVerifiedAt: new Date(),
          profile: {
            create: {
              firstName: payload.given_name,
              lastName: payload.family_name,
              avatarUrl: payload.picture,
            },
          },
          notificationPreference: { create: {} },
        },
      });

      await this.auditService.record({
        userId: user.id,
        action: 'USER_REGISTERED_GOOGLE',
        targetType: 'User',
        targetId: user.id,
        ipAddress: meta.ipAddress,
      });
    } else {
      if (user.status === AccountStatus.SUSPENDED || user.status === AccountStatus.DEACTIVATED) {
        throw new ForbiddenAppException(
          ErrorCode.AUTH_ACCOUNT_SUSPENDED,
          'This account is not active',
        );
      }

      if (!user.googleId) {
        await this.prisma.user.update({ where: { id: user.id }, data: { googleId } });
      }
    }

    const tokens = await this.issueTokenPair(user.id, user.email, user.role, meta);

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.auditService.record({
      userId: user.id,
      action: isNewUser ? 'USER_LOGIN_GOOGLE_FIRST' : 'USER_LOGIN_GOOGLE',
      targetType: 'User',
      targetId: user.id,
      ipAddress: meta.ipAddress,
    });

    return {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      tokens,
      isNewUser,
      needsRole: false,
    };
  }

  async logout(userId: string, refreshTokenRaw: string | undefined): Promise<void> {
    if (refreshTokenRaw) {
      const hash = hashOpaqueToken(refreshTokenRaw);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: hash, userId },
        data: { revokedAt: new Date() },
      });
    }
    await this.auditService.record({
      userId,
      action: 'USER_LOGOUT',
      targetType: 'User',
      targetId: userId,
    });
  }

  async logoutAllDevices(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.auditService.record({
      userId,
      action: 'USER_LOGOUT_ALL',
      targetType: 'User',
      targetId: userId,
    });
  }

  /**
   * Rotates refresh tokens on every use. If a token from an already-used
   * (revoked) family is presented, the whole family is revoked — this
   * detects stolen-token reuse.
   */
  async refresh(refreshTokenRaw: string, meta: RequestMeta): Promise<AuthTokens> {
    const hash = hashOpaqueToken(refreshTokenRaw);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });

    if (!stored) {
      throw new UnauthorizedAppException(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid refresh token');
    }

    if (stored.revokedAt || stored.expiresAt < new Date()) {
      await this.prisma.refreshToken.updateMany({
        where: { family: stored.family, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_TOKEN_EXPIRED,
        'Refresh token expired or reused',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || user.deletedAt || user.status === AccountStatus.SUSPENDED) {
      throw new UnauthorizedAppException(ErrorCode.AUTH_UNAUTHORIZED, 'Account not available');
    }

    const tokens = await this.issueTokenPair(user.id, user.email, user.role, meta, stored.family);

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: tokens.refreshToken.slice(0, 12) },
    });

    return tokens;
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const hash = hashOpaqueToken(rawToken);
    const token = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hash },
    });

    if (!token || token.usedAt || token.expiresAt < new Date()) {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_INVALID_TOKEN,
        'Invalid or expired verification token',
      );
    }

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: new Date(), status: AccountStatus.ACTIVE },
      }),
    ]);

    await this.auditService.record({
      userId: token.userId,
      action: 'EMAIL_VERIFIED',
      targetType: 'User',
      targetId: token.userId,
    });
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Deliberately do not reveal whether the account exists.
    if (!user || user.deletedAt) {
      return;
    }

    const { raw, hash } = generateOpaqueToken();
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    await this.emailService.sendPasswordResetEmail(
      user.email,
      raw,
      this.configService.get('appUrl', { infer: true }),
    );
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const hash = hashOpaqueToken(rawToken);
    const token = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: hash } });

    if (!token || token.usedAt || token.expiresAt < new Date()) {
      throw new UnauthorizedAppException(
        ErrorCode.AUTH_INVALID_TOKEN,
        'Invalid or expired reset token',
      );
    }

    const passwordHash = await this.passwordService.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({ where: { id: token.userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.auditService.record({
      userId: token.userId,
      action: 'PASSWORD_RESET',
      targetType: 'User',
      targetId: token.userId,
    });
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
      profile: user.profile,
    };
  }

  private async issueEmailVerificationToken(userId: string, email: string): Promise<void> {
    const { raw, hash } = generateOpaqueToken();
    await this.prisma.emailVerificationToken.create({
      data: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await this.emailService.sendVerificationEmail(
      email,
      raw,
      this.configService.get('appUrl', { infer: true }),
    );
  }

  private async issueTokenPair(
    userId: string,
    email: string,
    role: UserRole,
    meta: RequestMeta,
    existingFamily?: string,
  ): Promise<AuthTokens> {
    const authConfig = this.configService.get('auth', { infer: true });
    const payload: JwtPayload = { sub: userId, email, role };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: authConfig.jwtSecret,
      expiresIn: authConfig.jwtAccessTtl,
    });

    const { raw: refreshTokenRaw, hash } = generateOpaqueToken();
    const family = existingFamily ?? generateOpaqueToken().hash;
    const expiresAt = new Date(Date.now() + parseDurationMs(authConfig.jwtRefreshTtl));

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hash,
        family,
        expiresAt,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
      },
    });

    return { accessToken, refreshToken: refreshTokenRaw, refreshTokenExpiresAt: expiresAt };
  }
}
