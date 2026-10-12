import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';

// Probes hit these from one source on a fixed interval; they must never be
// rate limited, or a 429 would mark a healthy instance as down.
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  // Served at the root, outside the global prefix (see main.ts), so platform
  // health checks get a stable path. No DB access — only proves the process is up.
  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('health')
  liveness() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.prismaHealth.pingCheck('database', this.prisma)]);
  }
}
