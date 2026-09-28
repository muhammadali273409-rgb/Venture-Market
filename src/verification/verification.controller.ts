import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { VerificationService } from './verification.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SubmitVerificationDto } from './dto/submit-verification.dto';
import { ReviewVerificationDto } from './dto/review-verification.dto';

@Controller()
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post('businesses/:id/verification')
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') businessId: string,
    @Body() dto: SubmitVerificationDto,
  ) {
    return this.verificationService.submit(user, businessId, dto);
  }

  @Get('businesses/:id/verification')
  list(@CurrentUser() user: AuthenticatedUser, @Param('id') businessId: string) {
    return this.verificationService.listForBusiness(user, businessId);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @Patch('verification/:id/review')
  review(
    @CurrentUser() reviewer: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewVerificationDto,
  ) {
    return this.verificationService.review(reviewer, id, dto);
  }
}
