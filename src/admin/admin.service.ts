import { Injectable } from '@nestjs/common';
import { BusinessStatus, ListingStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CursorPaginationQuery } from '../common/dto/pagination.dto';
import { buildCursorPage } from '../common/utils/cursor-pagination';
import { ErrorCode } from '../common/constants/error-codes';
import { NotFoundAppException } from '../common/errors/app.exception';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async listUsers(query: CursorPaginationQuery) {
    const limit = query.limit ?? 20;
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    return buildCursorPage(users, limit);
  }

  async listBusinesses(query: CursorPaginationQuery & { status?: BusinessStatus }) {
    const limit = query.limit ?? 20;
    const businesses = await this.prisma.business.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { listing: true, owner: { select: { id: true, email: true } } },
    });
    return buildCursorPage(businesses, limit);
  }

  async listVerifications(query: CursorPaginationQuery) {
    const limit = query.limit ?? 20;
    const items = await this.prisma.businessVerification.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { business: { select: { id: true, name: true } } },
    });
    return buildCursorPage(items, limit);
  }

  async listReports(query: CursorPaginationQuery) {
    const limit = query.limit ?? 20;
    const items = await this.prisma.report.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    return buildCursorPage(items, limit);
  }

  async listDeals(query: CursorPaginationQuery) {
    const limit = query.limit ?? 20;
    const items = await this.prisma.deal.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { business: { select: { id: true, name: true } } },
    });
    return buildCursorPage(items, limit);
  }

  async listAuditLogs(query: CursorPaginationQuery) {
    const limit = query.limit ?? 50;
    const items = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    return buildCursorPage(items, limit);
  }

  async approveBusiness(admin: AuthenticatedUser, businessId: string, reason?: string) {
    const business = await this.transitionBusiness(
      businessId,
      BusinessStatus.PENDING_REVIEW,
      BusinessStatus.PUBLISHED,
    );
    await this.prisma.businessListing.update({
      where: { businessId },
      data: { status: ListingStatus.PUBLISHED, publishedAt: new Date() },
    });
    await this.recordAdminAction(admin, 'BUSINESS_APPROVED', businessId, reason);
    await this.notificationsService.create({
      userId: business.ownerId,
      type: 'VERIFICATION_UPDATE',
      title: 'Your business listing was approved',
      metadata: { businessId },
    });
    return business;
  }

  async rejectBusiness(admin: AuthenticatedUser, businessId: string, reason?: string) {
    const business = await this.transitionBusiness(
      businessId,
      BusinessStatus.PENDING_REVIEW,
      BusinessStatus.REJECTED,
    );
    await this.prisma.businessListing.update({
      where: { businessId },
      data: { status: ListingStatus.DRAFT },
    });
    await this.recordAdminAction(admin, 'BUSINESS_REJECTED', businessId, reason);
    await this.notificationsService.create({
      userId: business.ownerId,
      type: 'VERIFICATION_UPDATE',
      title: 'Your business listing was rejected',
      body: reason,
      metadata: { businessId },
    });
    return business;
  }

  async suspendBusiness(admin: AuthenticatedUser, businessId: string, reason?: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }
    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: { status: BusinessStatus.SUSPENDED },
    });
    await this.prisma.businessListing.update({
      where: { businessId },
      data: { status: ListingStatus.SUSPENDED },
    });
    await this.recordAdminAction(admin, 'BUSINESS_SUSPENDED', businessId, reason);
    await this.notificationsService.create({
      userId: business.ownerId,
      type: 'VERIFICATION_UPDATE',
      title: 'Your business listing was suspended',
      body: reason,
      metadata: { businessId },
    });
    return updated;
  }

  private async transitionBusiness(
    businessId: string,
    fromStatus: BusinessStatus,
    toStatus: BusinessStatus,
  ) {
    const result = await this.prisma.business.updateMany({
      where: { id: businessId, status: fromStatus },
      data: { status: toStatus },
    });
    if (result.count === 0) {
      throw new NotFoundAppException(
        ErrorCode.BUSINESS_NOT_FOUND,
        `Business not found or not in ${fromStatus} state`,
      );
    }
    return this.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  }

  private async recordAdminAction(
    admin: AuthenticatedUser,
    action: string,
    targetId: string,
    reason?: string,
  ) {
    await this.prisma.adminAction.create({
      data: { actorId: admin.id, action, targetType: 'Business', targetId, reason },
    });
    await this.auditService.record({
      userId: admin.id,
      action,
      targetType: 'Business',
      targetId,
      metadata: { reason },
    });
  }
}
