import { HttpStatus, Injectable } from '@nestjs/common';
import { DealParticipantRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DealsService, PRINCIPAL_ROLES } from '../deals/deals.service';
import { ErrorCode } from '../common/constants/error-codes';
import {
  AppException,
  ConflictAppException,
  NotFoundAppException,
} from '../common/errors/app.exception';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateAgreementDto } from './dto/create-agreement.dto';
import { CreateAgreementVersionDto } from './dto/create-version.dto';

const AGREEMENT_AUTHOR_ROLES: DealParticipantRole[] = [...PRINCIPAL_ROLES, 'LAWYER'];

/**
 * Agreements produced here — including any AI-assisted drafts — are not
 * legal advice. `generatedByAI` and `reviewRequired` must always be surfaced
 * to clients so they never present a draft as final counsel.
 */
@Injectable()
export class AgreementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealsService: DealsService,
  ) {}

  async create(user: AuthenticatedUser, dealId: string, dto: CreateAgreementDto) {
    await this.dealsService.assertParticipantRole(
      user.id,
      dealId,
      AGREEMENT_AUTHOR_ROLES,
      'Only the buyer, seller or a lawyer can draft agreements',
    );
    await this.dealsService.assertDealStatus(
      dealId,
      'AGREEMENT',
      'Agreements can only be drafted in the AGREEMENT stage',
    );
    const agreement = await this.prisma.agreement.create({
      data: {
        dealId,
        title: dto.title,
        generatedByAI: dto.generatedByAI ?? false,
        reviewRequired: true,
      },
    });
    await this.dealsService.addTimelineEvent(dealId, 'AGREEMENT_CREATED', user.id, {
      agreementId: agreement.id,
    });
    return agreement;
  }

  async list(user: AuthenticatedUser, dealId: string) {
    await this.dealsService.assertParticipant(user.id, dealId);
    return this.prisma.agreement.findMany({
      where: { dealId },
      include: { versions: { include: { signatures: true }, orderBy: { version: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addVersion(
    user: AuthenticatedUser,
    dealId: string,
    agreementId: string,
    dto: CreateAgreementVersionDto,
  ) {
    await this.dealsService.assertParticipantRole(
      user.id,
      dealId,
      AGREEMENT_AUTHOR_ROLES,
      'Only the buyer, seller or a lawyer can add agreement versions',
    );
    await this.dealsService.assertDealStatus(
      dealId,
      'AGREEMENT',
      'Agreements can only be changed in the AGREEMENT stage',
    );
    const agreement = await this.getAgreement(dealId, agreementId); // throws if not in this deal
    if (agreement.status === 'SIGNED' || agreement.status === 'VOID') {
      throw new ConflictAppException(
        ErrorCode.CONFLICT,
        `A ${agreement.status.toLowerCase()} agreement cannot be changed`,
      );
    }

    if (!dto.contentUrl && !dto.documentId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Attach the agreement file or a link to it',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.documentId) {
      // The file must be a deal document both parties can open — a version
      // nobody else can read can't be meaningfully signed.
      const document = await this.prisma.businessDocument.findFirst({
        where: { id: dto.documentId, dealId, deletedAt: null, visibility: { not: 'PRIVATE' } },
      });
      if (!document) {
        throw new NotFoundAppException(
          ErrorCode.DOCUMENT_NOT_FOUND,
          'Document not found in this deal',
        );
      }
    }

    const latest = await this.prisma.agreementVersion.findFirst({
      where: { agreementId },
      orderBy: { version: 'desc' },
    });

    const version = await this.prisma.agreementVersion.create({
      data: {
        agreementId,
        version: (latest?.version ?? 0) + 1,
        contentUrl: dto.contentUrl,
        contentHash: dto.contentHash?.toLowerCase(),
        documentId: dto.documentId,
        createdById: user.id,
      },
    });

    await this.prisma.agreement.update({
      where: { id: agreementId },
      data: { status: 'PENDING_SIGNATURE' },
    });
    await this.dealsService.addTimelineEvent(dealId, 'AGREEMENT_VERSION_ADDED', user.id, {
      agreementId,
      version: version.version,
    });

    return version;
  }

  /**
   * Buyer and seller sign the latest version. Once both have, the agreement
   * is SIGNED and the deal moves to TRANSACTION — that is the only way into
   * the payment stage.
   */
  async sign(user: AuthenticatedUser, dealId: string, agreementId: string, versionId: string) {
    await this.dealsService.assertParticipantRole(
      user.id,
      dealId,
      PRINCIPAL_ROLES,
      'Only the buyer and seller sign the agreement',
    );
    await this.dealsService.assertDealStatus(
      dealId,
      'AGREEMENT',
      'Agreements can only be signed in the AGREEMENT stage',
    );
    const agreement = await this.getAgreement(dealId, agreementId);
    if (agreement.status === 'VOID' || agreement.status === 'SIGNED') {
      throw new ConflictAppException(
        ErrorCode.CONFLICT,
        `This agreement is already ${agreement.status.toLowerCase()}`,
      );
    }

    // The version must belong to *this* agreement and be the current one.
    const latest = await this.prisma.agreementVersion.findFirst({
      where: { agreementId },
      orderBy: { version: 'desc' },
    });
    if (!latest || latest.id !== versionId) {
      throw new ConflictAppException(
        ErrorCode.CONFLICT,
        'Only the latest version of this agreement can be signed',
      );
    }

    const signature = await this.prisma.agreementSignature.upsert({
      where: { agreementVersionId_userId: { agreementVersionId: versionId, userId: user.id } },
      create: { agreementVersionId: versionId, userId: user.id },
      update: {},
    });

    const principals = await this.prisma.dealParticipant.findMany({
      where: { dealId, role: { in: PRINCIPAL_ROLES } },
      select: { userId: true },
    });
    const principalSignatures = await this.prisma.agreementSignature.count({
      where: { agreementVersionId: versionId, userId: { in: principals.map((p) => p.userId) } },
    });
    const fullySigned = principalSignatures >= principals.length;

    await this.prisma.agreement.update({
      where: { id: agreementId },
      data: { status: fullySigned ? 'SIGNED' : 'PARTIALLY_SIGNED' },
    });

    await this.dealsService.addTimelineEvent(dealId, 'AGREEMENT_SIGNED', user.id, {
      agreementId,
      versionId,
    });

    if (fullySigned) {
      await this.dealsService.transition(dealId, 'AGREEMENT', 'TRANSACTION', null);
    } else {
      await this.dealsService.notifyParticipants(
        dealId,
        user.id,
        'The other party signed the agreement — your signature is needed',
      );
    }

    return signature;
  }

  private async getAgreement(dealId: string, agreementId: string) {
    const agreement = await this.prisma.agreement.findFirst({ where: { id: agreementId, dealId } });
    if (!agreement) {
      throw new NotFoundAppException(ErrorCode.NOT_FOUND, 'Agreement not found');
    }
    return agreement;
  }
}
