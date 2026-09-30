import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { DealsService } from './deals.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { AddParticipantDto } from './dto/add-participant.dto';
import { UpdateDealStatusDto } from './dto/update-deal-status.dto';

@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.dealsService.listForUser(user);
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.dealsService.getOne(user, id);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDealStatusDto,
  ) {
    return this.dealsService.updateStatus(user, id, dto);
  }

  /** Buyer/seller signs the deal NDA; due diligence opens once both have signed. */
  @Post(':id/nda/sign')
  signNda(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.dealsService.signNda(user, id);
  }

  /** Seller: the business has been handed over. */
  @Post(':id/confirm-transfer')
  confirmTransfer(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.dealsService.confirmTransfer(user, id);
  }

  /** Buyer: the business was received — completes the deal. */
  @Post(':id/confirm-receipt')
  confirmReceipt(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.dealsService.confirmReceipt(user, id);
  }

  @Post(':id/participants')
  addParticipant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddParticipantDto,
  ) {
    return this.dealsService.addParticipant(user, id, dto);
  }

  @Post(':id/tasks')
  createTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.dealsService.createTask(user, id, dto);
  }

  @Get(':id/tasks')
  listTasks(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.dealsService.listTasks(user, id);
  }

  @Patch(':id/tasks/:taskId/status')
  updateTaskStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return this.dealsService.updateTaskStatus(user, id, taskId, dto);
  }
}
