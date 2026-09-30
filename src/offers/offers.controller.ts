import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { BUYER_ROLES } from '../common/constants/roles';
import { Throttle } from '@nestjs/throttler';
import { OffersService } from './offers.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateOfferDto } from './dto/create-offer.dto';
import { CounterOfferDto } from './dto/counter-offer.dto';

/**
 * Only buyer accounts open a negotiation (POST businesses/:id/offers). The
 * follow-up actions are open to either party, but the service decides which
 * side may do what from the offer itself (buyerId/sellerId/createdById) —
 * never from the request.
 */
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller()
export class OffersController {
  constructor(private readonly offersService: OffersService) {}

  @UseGuards(RolesGuard)
  @Roles(...BUYER_ROLES)
  @Post('businesses/:id/offers')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') businessId: string,
    @Body() dto: CreateOfferDto,
  ) {
    return this.offersService.create(user, businessId, dto);
  }

  @Get('offers')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.offersService.listForUser(user);
  }

  @Get('offers/:id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.offersService.findOne(user, id);
  }

  @Post('offers/:id/counter')
  counter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CounterOfferDto,
  ) {
    return this.offersService.counter(user, id, dto);
  }

  @Post('offers/:id/accept')
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.offersService.accept(user, id);
  }

  @Post('offers/:id/reject')
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.offersService.reject(user, id);
  }

  @Post('offers/:id/withdraw')
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.offersService.withdraw(user, id);
  }
}
