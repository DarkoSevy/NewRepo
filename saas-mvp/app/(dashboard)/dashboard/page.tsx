import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { DashboardContent } from "@/components/dashboard/dashboard-content";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const membership = await db.organizationMember.findFirst({
    where: { userId: session.user.id },
    include: { organization: true },
    orderBy: { joinedAt: "asc" },
  });

  if (!membership) redirect("/login");

  const [projects, recentTasks, stats] = await Promise.all([
    db.project.findMany({
      where: { organizationId: membership.organizationId },
      include: { _count: { select: { tasks: true } } },
      orderBy: { updatedAt: "desc" },
      take: 6,
    }),
    db.task.findMany({
      where: {
        project: { organizationId: membership.organizationId },
        assigneeId: session.user.id,
        status: { notIn: ["DONE", "CANCELED"] },
      },
      include: {
        project: { select: { id: true, name: true, color: true } },
        assignee: { select: { id: true, name: true, image: true } },
      },
      orderBy: [{ priority: "asc" }, { dueDate: "asc" }],
      take: 8,
    }),
    db.$transaction([
      db.task.count({
        where: { project: { organizationId: membership.organizationId }, status: "DONE" },
      }),
      db.task.count({
        where: { project: { organizationId: membership.organizationId }, status: { notIn: ["DONE", "CANCELED"] } },
      }),
      db.organizationMember.count({ where: { organizationId: membership.organizationId } }),
    ]),
  ]);

  const [completedTasks, activeTasks, memberCount] = stats;

  return (
    <DashboardContent
      user={session.user}
      org={membership.organization}
      projects={projects}
      myTasks={recentTasks}
      stats={{ completedTasks, activeTasks, memberCount, projectCount: projects.length }}
    />
  );
}
