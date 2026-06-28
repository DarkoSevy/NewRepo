import { z } from "zod";
import { MemberRole } from "@prisma/client";

export const createOrganizationSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
});

export const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  logo: z.string().url().optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.nativeEnum(MemberRole).exclude(["OWNER"]),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
