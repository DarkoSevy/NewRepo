import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, created, noContent, handleError, ApiError } from "@/lib/api-response";
import { inviteMemberSchema } from "@/lib/validations/organization";
import { sendInvitationEmail } from "@/lib/email";
import { createAuditLog } from "@/lib/audit";
import { addDays } from "date-fns";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();

    const isMember = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: params.id, userId: session.id } },
    });
    if (!isMember) return ApiError.forbidden();

    const members = await db.organizationMember.findMany({
      where: { organizationId: params.id },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { joinedAt: "asc" },
    });

    return ok(members);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();

    const caller = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: params.id, userId: session.id } },
      include: { user: true, organization: true },
    });
    if (!caller || !["OWNER", "ADMIN"].includes(caller.role)) return ApiError.forbidden();

    const body = await req.json();
    const data = inviteMemberSchema.parse(body);

    const existingUser = await db.user.findUnique({ where: { email: data.email } });
    if (existingUser) {
      const alreadyMember = await db.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: params.id, userId: existingUser.id },
        },
      });
      if (alreadyMember) return ApiError.conflict("User is already a member");
    }

    const invitation = await db.invitation.create({
      data: {
        organizationId: params.id,
        email: data.email,
        role: data.role,
        expiresAt: addDays(new Date(), 7),
      },
    });

    await sendInvitationEmail({
      to: data.email,
      inviterName: caller.user.name ?? "A team member",
      organizationName: caller.organization.name,
      token: invitation.token,
    }).catch(console.error);

    await createAuditLog({
      userId: session.id,
      action: "INVITE_MEMBER",
      resource: "invitation",
      resourceId: invitation.id,
      organizationId: params.id,
      metadata: { email: data.email, role: data.role },
      req,
    });

    return created({ id: invitation.id, email: invitation.email, role: invitation.role });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    const url = new URL(req.url);
    const memberId = url.searchParams.get("memberId");

    if (!memberId) return ApiError.badRequest("memberId is required");

    const caller = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: params.id, userId: session.id } },
    });

    const isRemovingSelf = memberId === session.id;
    const isAdmin = caller && ["OWNER", "ADMIN"].includes(caller.role);

    if (!isRemovingSelf && !isAdmin) return ApiError.forbidden();

    const target = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: params.id, userId: memberId } },
    });

    if (!target) return ApiError.notFound("Member");
    if (target.role === "OWNER") return ApiError.forbidden();

    await db.organizationMember.delete({
      where: { organizationId_userId: { organizationId: params.id, userId: memberId } },
    });

    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
