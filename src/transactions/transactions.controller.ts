import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TransactionsService } from './transactions.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { MarkPaidDto } from './dto/mark-paid.dto';
import { ListAdminTransactionsQuery, RejectPaymentDto } from './dto/admin-transaction.dto';

@Controller('deals/:dealId/transaction')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  /** `provider` in the body is accepted for older clients and ignored. */
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('dealId') dealId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Body() _dto: CreateTransactionDto,
  ) {
    return this.transactionsService.create(user, dealId);
  }

  @Get()
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('dealId') dealId: string) {
    return this.transactionsService.getForDeal(user, dealId);
  }

  /** Manual payments: the buyer says the money was sent. */
  @Post('mark-paid')
  markPaid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('dealId') dealId: string,
    @Body() dto: MarkPaidDto,
  ) {
    return this.transactionsService.markPaid(user, dealId, dto);
  }
}

@Controller('payments')
export class PaymentsConfigController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get('config')
  config() {
    return this.transactionsService.getPaymentConfig();
  }
}

@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/transactions')
export class AdminTransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  list(@Query() query: ListAdminTransactionsQuery) {
    return this.transactionsService.listForAdmin(query.status);
  }

  @Post(':id/confirm')
  confirm(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.transactionsService.confirmManualPayment(admin, id);
  }

  @Post(':id/reject')
  reject(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectPaymentDto,
  ) {
    return this.transactionsService.rejectManualPayment(admin, id, dto.reason);
  }
}
