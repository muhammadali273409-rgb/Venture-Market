import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AppConfiguration } from '../config/configuration';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from './types/authenticated-user.type';
import { AuthService, AuthTokens } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { parseDurationMs } from '../common/utils/duration';

const REFRESH_COOKIE = 'refresh_token';
const ACCESS_COOKIE = 'access_token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.authService.login(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, tokens);
    return { user };
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await this.authService.logout(user.id, refreshToken);
    this.clearAuthCookies(res);
    return { success: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('google')
  async googleLogin(
    @Body() dto: GoogleLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens, isNewUser, needsRole } = await this.authService.loginWithGoogle(
      dto.credential,
      dto.role,
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );

    // needsRole means no account/session was created — nothing to set a
    // cookie for yet. The frontend collects Buyer/Seller and resubmits the
    // same verified credential with a role to complete registration.
    if (needsRole || !tokens) {
      return { isNewUser, needsRole: true };
    }

    this.setAuthCookies(res, tokens);
    return { user, isNewUser, needsRole: false };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const tokens = await this.authService.refresh(refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, tokens);
    return { success: true };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token).then(() => ({ success: true }));
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-verification')
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto.email).then(() => ({
      success: true,
      message: 'If that account exists and is not verified yet, a new link has been sent.',
    }));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email).then(() => ({
      success: true,
      message: 'If that email exists, a reset link has been sent.',
    }));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService
      .resetPassword(dto.token, dto.newPassword)
      .then(() => ({ success: true }));
  }

  /** Short-lived token for the realtime Socket.IO handshake — see socket-token.ts. */
  @Get('socket-token')
  socketToken(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.issueSocketToken(user.id).then((token) => ({ token }));
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getMe(user.id);
  }

  private setAuthCookies(res: Response, tokens: AuthTokens): void {
    const authConfig = this.configService.get('auth', { infer: true });
    const isProd = this.configService.get('nodeEnv', { infer: true }) === 'production';

    // 'none' is required in production because the frontend is deployed on a
    // different domain than this API — SameSite=Lax cookies are not sent on
    // cross-site fetch/XHR, only on top-level navigation, which would silently
    // break every authenticated request. 'none' requires Secure, which is why
    // this is gated to production (isProd === secure here).
    const sameSite = isProd ? ('none' as const) : ('lax' as const);

    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite,
      maxAge: parseDurationMs(authConfig.jwtAccessTtl),
      path: '/',
    });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite,
      maxAge: tokens.refreshTokenExpiresAt.getTime() - Date.now(),
      path: '/api/v1/auth',
    });
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }
}
