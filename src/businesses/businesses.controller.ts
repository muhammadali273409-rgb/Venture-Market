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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UserRole } from '@prisma/client';
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
import { UploadImageDto } from './dto/upload-image.dto';

/** Creating a business is seller-only — an admin never sells on the platform. */
const SellerOnly = () => Roles(...SELLER_ROLES);

/**
 * Managing an existing business: its seller, or an admin moderating it.
 * Ownership is then enforced per business in the service (canManage).
 */
const SellerOrAdmin = () => Roles(...SELLER_ROLES, UserRole.ADMIN);

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

  @SellerOrAdmin()
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businessesService.update(user, id, dto);
  }

  @SellerOrAdmin()
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.softDelete(user, id);
  }

  @SellerOrAdmin()
  @Patch(':id/listing')
  updateListing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.businessesService.updateListing(user, id, dto);
  }

  @SellerOrAdmin()
  @Post(':id/metrics')
  addMetric(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateMetricDto,
  ) {
    return this.businessesService.addMetric(user, id, dto);
  }

  /** Multipart upload: `file` (JPEG/PNG/WebP, ≤5MB) + optional `kind` (LOGO | GALLERY). */
  @SellerOrAdmin()
  @Post(':id/images')
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  uploadImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadImageDto,
  ) {
    return this.businessesService.uploadImage(user, id, file, dto.kind);
  }

  @SellerOrAdmin()
  @Delete(':id/images/:imageId')
  @HttpCode(HttpStatus.OK)
  deleteImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.businessesService.deleteImage(user, id, imageId);
  }

  /** DRAFT/REJECTED → PUBLISHED (live on the marketplace); PAUSED → PUBLISHED. */
  @SellerOrAdmin()
  @Post(':id/publish')
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.publish(user, id);
  }

  /** Optional manual-review path, kept for existing clients. */
  @SellerOnly()
  @Post(':id/submit-review')
  submitForReview(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.submitForReview(user, id);
  }

  @SellerOnly()
  @Post(':id/withdraw-submission')
  withdrawSubmission(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.withdrawSubmission(user, id);
  }

  @SellerOrAdmin()
  @Post(':id/resume')
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.resume(user, id);
  }

  @SellerOrAdmin()
  @Post(':id/unpublish')
  unpublish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.businessesService.unpublish(user, id);
  }
}
