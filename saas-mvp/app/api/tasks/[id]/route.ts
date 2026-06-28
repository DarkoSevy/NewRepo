import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, noContent, handleError, ApiError } from "@/lib/api-response";
import { updateTaskSchema } from "@/lib/validations/task";
import { createAuditLog } from "@/lib/audit";

async function getTaskAndCheckAccess(taskId: string, userId: string) {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      project: {
        include: {
          organization: { include: { members: { where: { userId } } } },
        },
      },
    },
  });

  if (!task) throw new Error("NOT_FOUND");
  if (!task.project.organization.members.length) throw new Error("FORBIDDEN");

  return { task, member: task.project.organization.members[0] };
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    await getTaskAndCheckAccess(params.id, session.id);

    const task = await db.task.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        assignee: { select: { id: true, name: true, image: true } },
        creator: { select: { id: true, name: true, image: true } },
        labels: true,
        attachments: true,
        comments: {
          include: {
            author: { select: { id: true, name: true, image: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    return ok(task);
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    const { task, member } = await getTaskAndCheckAccess(params.id, session.id);

    if (member.role === "VIEWER") return ApiError.forbidden();

    const body = await req.json();
    const data = updateTaskSchema.parse(body);
    const { labelIds, ...updateData } = data;

    const updated = await db.task.update({
      where: { id: params.id },
      data: {
        ...updateData,
        dueDate: updateData.dueDate ? new Date(updateData.dueDate) : undefined,
        completedAt:
          updateData.status === "DONE" ? new Date() :
          updateData.status && updateData.status !== "DONE" ? null : undefined,
        labels: labelIds ? { set: labelIds.map((id) => ({ id })) } : undefined,
      },
      include: {
        assignee: { select: { id: true, name: true, image: true } },
        labels: true,
      },
    });

    // Notify on reassignment
    if (data.assigneeId && data.assigneeId !== task.assigneeId && data.assigneeId !== session.id) {
      await db.notification.create({
        data: {
          userId: data.assigneeId,
          type: "TASK_ASSIGNED",
          title: `You were assigned: ${updated.title}`,
          href: `/dashboard/projects/${task.projectId}?task=${task.id}`,
        },
      });
    }

    await createAuditLog({
      userId: session.id,
      action: "UPDATE_TASK",
      resource: "task",
      resourceId: params.id,
      projectId: task.projectId,
      metadata: data,
      req,
    });

    return ok(updated);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();
    const { task, member } = await getTaskAndCheckAccess(params.id, session.id);

    if (member.role === "VIEWER") return ApiError.forbidden();

    await db.task.delete({ where: { id: params.id } });

    await createAuditLog({
      userId: session.id,
      action: "DELETE_TASK",
      resource: "task",
      resourceId: params.id,
      projectId: task.projectId,
    });

    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
