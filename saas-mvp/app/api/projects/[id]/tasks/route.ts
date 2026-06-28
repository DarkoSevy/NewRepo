import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ok, created, handleError, ApiError } from "@/lib/api-response";
import { createTaskSchema } from "@/lib/validations/task";
import { createAuditLog } from "@/lib/audit";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();

    const project = await db.project.findUnique({
      where: { id: params.id },
      include: { organization: { include: { members: { where: { userId: session.id } } } } },
    });
    if (!project || !project.organization.members.length) return ApiError.forbidden();

    const tasks = await db.task.findMany({
      where: { projectId: params.id },
      include: {
        assignee: { select: { id: true, name: true, image: true } },
        creator: { select: { id: true, name: true, image: true } },
        labels: true,
        _count: { select: { comments: true, attachments: true } },
      },
      orderBy: [{ status: "asc" }, { position: "asc" }],
    });

    return ok(tasks);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth();

    const project = await db.project.findUnique({
      where: { id: params.id },
      include: { organization: { include: { members: { where: { userId: session.id } } } } },
    });

    if (!project) return ApiError.notFound("Project");
    const member = project.organization.members[0];
    if (!member || member.role === "VIEWER") return ApiError.forbidden();

    const body = await req.json();
    const data = createTaskSchema.parse(body);

    // Calculate position (end of column)
    const lastTask = await db.task.findFirst({
      where: { projectId: params.id, status: data.status ?? "TODO" },
      orderBy: { position: "desc" },
    });
    const position = (lastTask?.position ?? 0) + 1000;

    const { labelIds, ...taskData } = data;

    const task = await db.task.create({
      data: {
        ...taskData,
        projectId: params.id,
        creatorId: session.id,
        position,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        labels: labelIds?.length ? { connect: labelIds.map((id) => ({ id })) } : undefined,
      },
      include: {
        assignee: { select: { id: true, name: true, image: true } },
        labels: true,
        _count: { select: { comments: true } },
      },
    });

    if (data.assigneeId && data.assigneeId !== session.id) {
      await db.notification.create({
        data: {
          userId: data.assigneeId,
          type: "TASK_ASSIGNED",
          title: `You were assigned: ${task.title}`,
          href: `/dashboard/projects/${params.id}?task=${task.id}`,
        },
      });
    }

    await createAuditLog({
      userId: session.id,
      action: "CREATE_TASK",
      resource: "task",
      resourceId: task.id,
      projectId: params.id,
      organizationId: project.organizationId,
      req,
    });

    return created(task);
  } catch (err) {
    return handleError(err);
  }
}
