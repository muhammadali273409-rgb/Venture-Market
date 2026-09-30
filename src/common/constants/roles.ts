import { UserRole } from '@prisma/client';

/**
 * Platform roles allowed to act on the sell side (create/manage businesses,
 * receive offers). ADMIN is deliberately absent: moderation happens through
 * the /admin endpoints, never by an admin acting as a seller.
 */
export const SELLER_ROLES: UserRole[] = [UserRole.SELLER, UserRole.BUYER_SELLER];

/** Platform roles allowed to act on the buy side (make offers, request due diligence). */
export const BUYER_ROLES: UserRole[] = [UserRole.BUYER, UserRole.BUYER_SELLER];

export const REVIEWER_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.MODERATOR];
