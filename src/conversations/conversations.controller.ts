import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConversationsService } from './conversations.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { BUYER_ROLES } from '../common/constants/roles';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { StartBusinessConversationDto } from './dto/start-business-conversation.dto';
import { CursorPaginationQuery } from '../common/dto/pagination.dto';

const uuid = new ParseUUIDPipe();

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateConversationDto) {
    return this.conversationsService.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.conversationsService.listForUser(user);
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string) {
    return this.conversationsService.getForUser(user, id);
  }

  @Get(':id/messages')
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Query() query: CursorPaginationQuery,
  ) {
    return this.conversationsService.listMessages(user, id, query);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':id/messages')
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.conversationsService.sendMessage(user, id, dto);
  }
}

/**
 * Buyer → seller enquiry about a listing. The seller is resolved from the
 * business on the server; the body carries only an optional first message.
 */
@UseGuards(RolesGuard)
@Controller('businesses/:businessId/conversations')
export class BusinessConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Roles(...BUYER_ROLES)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', uuid) businessId: string,
    @Body() dto: StartBusinessConversationDto,
  ) {
    return this.conversationsService.startForBusiness(user, businessId, dto);
  }
}
