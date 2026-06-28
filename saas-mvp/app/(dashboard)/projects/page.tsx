import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { ProjectsContent } from "@/components/dashboard/projects-content";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const membership = await db.organizationMember.findFirst({
    where: { userId: session.user.id },
    include: { organization: true },
    orderBy: { joinedAt: "asc" },
  });
  if (!membership) redirect("/login");

  const projects = await db.project.findMany({
    where: { organizationId: membership.organizationId },
    include: {
      _count: { select: { tasks: true } },
      tasks: {
        where: { status: { notIn: ["DONE", "CANCELED"] } },
        select: { id: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <ProjectsContent
      projects={projects}
      org={membership.organization}
      userRole={membership.role}
    />
  );
}
