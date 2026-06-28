import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, noContent, handleError, ApiError } from "@/lib/api-response";
import { updateProjectSchema } from "@/lib/validations/project";
import { createAuditLog } from "@/lib/audit";

async function getProjectAndCheckAccess(projectId: string, userId: string, requireAdmin = false) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      organization: {
        include: {
          members: { where: { userId } },
        },
      },
    },
  });

  if (!project) throw new Error("NOT_FOUND");

  const member = project.organization.members[0];
  if (!member) throw new Error("FORBIDDEN");

  if (requireAdmin && !["OWNER", "ADMIN"].includes(member.role)) {
    throw new Error("FORBIDDEN");
  }

  return { project, member };
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    const { project } = await getProjectAndCheckAccess(params.id, session.id);

    const full = await db.project.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        _count: { select: { tasks: true } },
        labels: true,
        tasks: {
          include: {
            assignee: { select: { id: true, name: true, image: true } },
            labels: true,
            _count: { select: { comments: true } },
          },
          orderBy: [{ status: "asc" }, { position: "asc" }],
        },
      },
    });

    return ok(full);
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    await getProjectAndCheckAccess(params.id, session.id);

    const body = await req.json();
    const data = updateProjectSchema.parse(body);

    const project = await db.project.update({
      where: { id: params.id },
      data: {
        ...data,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
      },
    });

    await createAuditLog({
      userId: session.id,
      action: "UPDATE_PROJECT",
      resource: "project",
      resourceId: project.id,
      organizationId: project.organizationId,
      metadata: data,
      req,
    });

    return ok(project);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    const { project } = await getProjectAndCheckAccess(params.id, session.id, true);

    await db.project.delete({ where: { id: params.id } });

    await createAuditLog({
      userId: session.id,
      action: "DELETE_PROJECT",
      resource: "project",
      resourceId: params.id,
      organizationId: project.organizationId,
    });

    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
