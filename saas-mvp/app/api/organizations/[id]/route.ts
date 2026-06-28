import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, noContent, handleError, ApiError } from "@/lib/api-response";
import { updateOrganizationSchema } from "@/lib/validations/organization";

async function getOrgAndCheckAccess(orgId: string, userId: string, requireAdmin = false) {
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    include: { organization: true },
  });

  if (!member) throw new Error("NOT_FOUND");

  if (requireAdmin && !["OWNER", "ADMIN"].includes(member.role)) {
    throw new Error("FORBIDDEN");
  }

  return member;
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    await getOrgAndCheckAccess(params.id, session.id);

    const org = await db.organization.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        _count: { select: { members: true, projects: true } },
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
          orderBy: { joinedAt: "asc" },
        },
      },
    });

    return ok(org);
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    await getOrgAndCheckAccess(params.id, session.id, true);

    const body = await req.json();
    const data = updateOrganizationSchema.parse(body);

    const org = await db.organization.update({
      where: { id: params.id },
      data,
    });

    return ok(org);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    const member = await getOrgAndCheckAccess(params.id, session.id, true);

    if (member.role !== "OWNER") return ApiError.forbidden();

    await db.organization.delete({ where: { id: params.id } });
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
