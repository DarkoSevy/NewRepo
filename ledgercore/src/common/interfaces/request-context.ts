import { UserRole } from '@prisma/client';

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  role: UserRole;
}
