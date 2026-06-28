import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, created, handleError } from "@/lib/api-response";
import { createOrganizationSchema } from "@/lib/validations/organization";
import { slugify } from "@/lib/utils";

export async function GET() {
  try {
    const session = await requireAuth();

    const orgs = await db.organization.findMany({
      where: { members: { some: { userId: session.id } } },
      include: {
        _count: { select: { members: true, projects: true } },
        members: {
          where: { userId: session.id },
          select: { role: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return ok(orgs);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const body = await req.json();
    const data = createOrganizationSchema.parse(body);

    let slug = slugify(data.name);
    let suffix = 0;
    while (await db.organization.findUnique({ where: { slug: suffix === 0 ? slug : `${slug}-${suffix}` } })) {
      suffix++;
    }
    slug = suffix === 0 ? slug : `${slug}-${suffix}`;

    const org = await db.organization.create({
      data: {
        name: data.name,
        slug,
        members: { create: { userId: session.id, role: "OWNER" } },
      },
      include: { _count: { select: { members: true, projects: true } } },
    });

    return created(org);
  } catch (err) {
    return handleError(err);
  }
}
