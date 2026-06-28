import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, noContent, handleError, ApiError } from "@/lib/api-response";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  image: z.string().url().optional(),
});

export async function GET() {
  try {
    const session = await requireAuth();

    const user = await db.user.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        createdAt: true,
        memberships: {
          include: {
            organization: { select: { id: true, name: true, slug: true, plan: true, logo: true } },
          },
        },
      },
    });

    return ok(user);
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireAuth();
    const body = await req.json();
    const data = updateSchema.parse(body);

    const user = await db.user.update({
      where: { id: session.id },
      data,
      select: { id: true, name: true, email: true, image: true },
    });

    return ok(user);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE() {
  try {
    const session = await requireAuth();

    // Check user isn't the only owner of any org
    const ownedOrgs = await db.organizationMember.findMany({
      where: { userId: session.id, role: "OWNER" },
      include: {
        organization: {
          include: { members: { where: { role: "OWNER" } } },
        },
      },
    });

    const soleOwner = ownedOrgs.some((m) => m.organization.members.length === 1);
    if (soleOwner) {
      return ApiError.badRequest(
        "Transfer organization ownership before deleting your account"
      );
    }

    await db.user.delete({ where: { id: session.id } });
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
