import { Injectable } from '@nestjs/common';
import { DealStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../common/audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ErrorCode } from '../common/constants/error-codes';
import { ForbiddenAppException, NotFoundAppException } from '../common/errors/app.exception';
import { AppException } from '../common/errors/app.exception';
import { HttpStatus } from '@nestjs/common';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { GrantAccessDto } from './dto/grant-access.dto';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
]);

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Deal documents open up to the other side only once the NDA is signed
 * (DUE_DILIGENCE onwards), and close again if the deal is cancelled.
 */
const DEAL_DOCUMENTS_VISIBLE_STATUSES: DealStatus[] = [
  'DUE_DILIGENCE',
  'AGREEMENT',
  'TRANSACTION',
  'TRANSFER',
  'COMPLETED',
  'DISPUTED',
];

export interface UploadedFilePayload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
  ) {}

  async upload(
    user: AuthenticatedUser,
    businessId: string,
    file: UploadedFilePayload,
    dto: UploadDocumentDto,
  ) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new AppException(
        ErrorCode.DOCUMENT_INVALID_FILE,
        'File type not permitted',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new AppException(
        ErrorCode.DOCUMENT_INVALID_FILE,
        'File exceeds the 25MB limit',
        HttpStatus.BAD_REQUEST,
      );
    }

    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business || business.deletedAt) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }

    if (dto.dealId) {
      await this.assertDealParticipant(user.id, dto.dealId);
      const deal = await this.prisma.deal.findUnique({ where: { id: dto.dealId } });
      // The deal must be about *this* business — otherwise a buyer in one
      // deal could attach files to any other seller's business.
      if (!deal || deal.businessId !== businessId) {
        throw new ForbiddenAppException(
          ErrorCode.DEAL_ACCESS_DENIED,
          'This deal is not about this business',
        );
      }
      if (deal.status === 'COMPLETED' || deal.status === 'CANCELLED') {
        throw new ForbiddenAppException(
          ErrorCode.DEAL_ACCESS_DENIED,
          'Documents cannot be added to a closed deal',
        );
      }
    } else if (business.ownerId !== user.id && user.role !== UserRole.ADMIN) {
      throw new ForbiddenAppException(
        ErrorCode.BUSINESS_ACCESS_DENIED,
        'Only the business owner can upload documents outside a deal',
      );
    }

    const storageKey = this.storageService.buildObjectKey(businessId, file.originalname);
    await this.storageService.putObject(storageKey, file.buffer, file.mimetype);

    const document = await this.prisma.businessDocument.create({
      data: {
        businessId,
        dealId: dto.dealId,
        uploadedById: user.id,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storageKey,
        category: dto.category ?? 'OTHER',
        // A file uploaded into a deal is meant for the deal unless marked otherwise.
        visibility: dto.visibility ?? (dto.dealId ? 'DEAL_PARTICIPANTS' : 'PRIVATE'),
      },
    });

    await this.logAccess(document.id, user.id, 'UPLOADED');
    await this.auditService.record({
      userId: user.id,
      action: 'DOCUMENT_UPLOADED',
      targetType: 'BusinessDocument',
      targetId: document.id,
    });

    return document;
  }

  async getSignedDownloadUrl(user: AuthenticatedUser, documentId: string) {
    const document = await this.getAccessibleDocument(user, documentId);
    const url = await this.storageService.getSignedDownloadUrl(document.storageKey);
    await this.logAccess(document.id, user.id, 'DOWNLOADED');
    return { url, expiresInSeconds: 300 };
  }

  async grantAccess(user: AuthenticatedUser, documentId: string, dto: GrantAccessDto) {
    const document = await this.prisma.businessDocument.findUnique({
      where: { id: documentId },
      include: { business: true },
    });
    if (!document || document.deletedAt) {
      throw new NotFoundAppException(ErrorCode.DOCUMENT_NOT_FOUND, 'Document not found');
    }
    if (document.business.ownerId !== user.id && user.role !== UserRole.ADMIN) {
      throw new ForbiddenAppException(
        ErrorCode.DOCUMENT_ACCESS_DENIED,
        'Only the business owner can grant access',
      );
    }

    const access = await this.prisma.documentAccess.upsert({
      where: { documentId_granteeId: { documentId, granteeId: dto.granteeId } },
      create: {
        documentId,
        granteeId: dto.granteeId,
        grantedById: user.id,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      },
      update: { revokedAt: null, expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined },
    });

    await this.logAccess(documentId, user.id, 'ACCESS_GRANTED');
    return access;
  }

  async revokeAccess(user: AuthenticatedUser, documentId: string, granteeId: string) {
    const document = await this.prisma.businessDocument.findUnique({
      where: { id: documentId },
      include: { business: true },
    });
    if (!document) {
      throw new NotFoundAppException(ErrorCode.DOCUMENT_NOT_FOUND, 'Document not found');
    }
    if (document.business.ownerId !== user.id && user.role !== UserRole.ADMIN) {
      throw new ForbiddenAppException(
        ErrorCode.DOCUMENT_ACCESS_DENIED,
        'Only the business owner can revoke access',
      );
    }

    await this.prisma.documentAccess.updateMany({
      where: { documentId, granteeId },
      data: { revokedAt: new Date() },
    });
    await this.logAccess(documentId, user.id, 'ACCESS_REVOKED');
    return { success: true };
  }

  async remove(user: AuthenticatedUser, documentId: string) {
    const document = await this.prisma.businessDocument.findUnique({
      where: { id: documentId },
      include: { business: true },
    });
    if (!document || document.deletedAt) {
      throw new NotFoundAppException(ErrorCode.DOCUMENT_NOT_FOUND, 'Document not found');
    }
    if (document.business.ownerId !== user.id && user.role !== UserRole.ADMIN) {
      throw new ForbiddenAppException(
        ErrorCode.DOCUMENT_ACCESS_DENIED,
        'Only the business owner can delete this document',
      );
    }

    await this.prisma.businessDocument.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });
    await this.logAccess(documentId, user.id, 'DELETED');
    return { success: true };
  }

  async listForBusiness(user: AuthenticatedUser, businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }
    const isOwner = business.ownerId === user.id || user.role === UserRole.ADMIN;

    return this.prisma.businessDocument.findMany({
      where: {
        businessId,
        deletedAt: null,
        ...(isOwner
          ? {}
          : {
              OR: [
                { uploadedById: user.id },
                {
                  accessGrants: {
                    some: {
                      granteeId: user.id,
                      revokedAt: null,
                      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                    },
                  },
                },
                this.dealDocumentFilter(user.id),
              ],
            }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getAccessibleDocument(user: AuthenticatedUser, documentId: string) {
    const document = await this.prisma.businessDocument.findUnique({
      where: { id: documentId },
      include: { business: true, accessGrants: true, deal: { include: { participants: true } } },
    });

    if (!document || document.deletedAt) {
      throw new NotFoundAppException(ErrorCode.DOCUMENT_NOT_FOUND, 'Document not found');
    }

    const isOwner = document.business.ownerId === user.id;
    const isUploader = document.uploadedById === user.id;
    const isAdmin = user.role === UserRole.ADMIN;
    const isDealParticipant =
      !!document.deal &&
      document.visibility !== 'PRIVATE' &&
      DEAL_DOCUMENTS_VISIBLE_STATUSES.includes(document.deal.status) &&
      document.deal.participants.some((p) => p.userId === user.id);
    const hasExplicitGrant = document.accessGrants.some(
      (grant) =>
        grant.granteeId === user.id &&
        !grant.revokedAt &&
        (!grant.expiresAt || grant.expiresAt > new Date()),
    );

    if (!isOwner && !isUploader && !isAdmin && !isDealParticipant && !hasExplicitGrant) {
      throw new ForbiddenAppException(
        ErrorCode.DOCUMENT_ACCESS_DENIED,
        'You do not have access to this document',
      );
    }

    return document;
  }

  /** Prisma mirror of the deal-participant rule in getAccessibleDocument. */
  private dealDocumentFilter(userId: string): Prisma.BusinessDocumentWhereInput {
    return {
      visibility: { not: 'PRIVATE' },
      deal: {
        status: { in: DEAL_DOCUMENTS_VISIBLE_STATUSES },
        participants: { some: { userId } },
      },
    };
  }

  private async assertDealParticipant(userId: string, dealId: string): Promise<void> {
    const participant = await this.prisma.dealParticipant.findUnique({
      where: { dealId_userId: { dealId, userId } },
    });
    if (!participant) {
      throw new ForbiddenAppException(
        ErrorCode.DEAL_ACCESS_DENIED,
        'Not a participant of this deal',
      );
    }
  }

  private async logAccess(
    documentId: string,
    userId: string,
    action:
      | 'UPLOADED'
      | 'VIEWED'
      | 'DOWNLOADED'
      | 'REPLACED'
      | 'DELETED'
      | 'ACCESS_GRANTED'
      | 'ACCESS_REVOKED',
  ): Promise<void> {
    await this.prisma.documentAccessLog.create({ data: { documentId, userId, action } });
  }
}
