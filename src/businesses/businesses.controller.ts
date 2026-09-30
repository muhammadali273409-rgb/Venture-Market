import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SELLER_ROLES } from '../common/constants/roles';
import { BusinessesService } from './businesses.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { CreateMetricDto } from './dto/create-metric.dto';
import { UpdateListingDto } from './dto/update-listing.dto';

/** Every write here is seller-only; ownership is then enforced per business in the service. */
const SellerOnly = () => Roles(...SELLER_ROLES);

/**
 * Seller workspace. The reads are owner-scoped (a buyer simply gets an
 * empty list / 404), so they stay open to any signed-in user; buyers browse
 * through /listings, and admins moderate via /admin.
 */
@UseGuards(RolesGuard)
@Controller('businesses')
export class BusinessesController {
  constructor(private readonly businessesService: BusinessesService) {}

  @SellerOnly()
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBusinessDto) {
    return this.businessesService.create(user, dto);
  }

  @Get()
  listOwned(@CurrentUser() user: AuthenticatedUser) {
    return this.businessesService.listOwned(user);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.findOwned(user, id);
  }

  @SellerOnly()
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businessesService.update(user, id, dto);
  }

  @SellerOnly()
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.softDelete(user, id);
  }

  @SellerOnly()
  @Patch(':id/listing')
  updateListing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.businessesService.updateListing(user, id, dto);
  }

  @SellerOnly()
  @Post(':id/metrics')
  addMetric(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateMetricDto,
  ) {
    return this.businessesService.addMetric(user, id, dto);
  }

  @SellerOnly()
  @Post(':id/submit-review')
  submitForReview(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.submitForReview(user, id);
  }

  /** @deprecated Alias of submit-review kept for older clients — it never publishes directly. */
  @SellerOnly()
  @Post(':id/publish')
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.submitForReview(user, id);
  }

  @SellerOnly()
  @Post(':id/withdraw-submission')
  withdrawSubmission(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.withdrawSubmission(user, id);
  }

  @SellerOnly()
  @Post(':id/resume')
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.resume(user, id);
  }

  @SellerOnly()
  @Post(':id/unpublish')
  unpublish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.unpublish(user, id);
  }
}
