import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, created, handleError, ApiError } from "@/lib/api-response";
import { createProjectSchema } from "@/lib/validations/project";
import { createAuditLog } from "@/lib/audit";
import { PLANS } from "@/lib/stripe";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const orgId = req.nextUrl.searchParams.get("organizationId");
    if (!orgId) return ApiError.badRequest("organizationId is required");

    const member = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId: session.id } },
    });
    if (!member) return ApiError.forbidden();

    const projects = await db.project.findMany({
      where: { organizationId: orgId },
      include: {
        _count: { select: { tasks: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return ok(projects);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const body = await req.json();
    const { organizationId, ...data } = createProjectSchema.extend({
      organizationId: require("zod").z.string().cuid(),
    }).parse({ ...body });

    const member = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: session.id } },
      include: { organization: true },
    });
    if (!member || member.role === "VIEWER") return ApiError.forbidden();

    // Enforce plan limits
    const projectCount = await db.project.count({ where: { organizationId } });
    const planLimits = PLANS[member.organization.plan].limits;
    if (projectCount >= planLimits.projects) {
      return ApiError.badRequest(`Upgrade your plan to create more than ${planLimits.projects} projects`);
    }

    const project = await db.project.create({
      data: {
        ...data,
        organizationId,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
      },
      include: { _count: { select: { tasks: true } } },
    });

    await createAuditLog({
      userId: session.id,
      action: "CREATE_PROJECT",
      resource: "project",
      resourceId: project.id,
      organizationId,
      req,
    });

    return created(project);
  } catch (err) {
    return handleError(err);
  }
}
