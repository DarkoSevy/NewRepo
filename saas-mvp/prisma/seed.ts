import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  console.log("🌱 Seeding...");

  const passwordHash = await bcrypt.hash("Password123!", 12);

  const user = await db.user.upsert({
    where: { email: "demo@nexushub.com" },
    update: {},
    create: {
      name: "Demo User",
      email: "demo@nexushub.com",
      passwordHash,
    },
  });

  const org = await db.organization.upsert({
    where: { slug: "acme-corp" },
    update: {},
    create: {
      name: "Acme Corp",
      slug: "acme-corp",
      plan: "PRO",
      subscriptionStatus: "ACTIVE",
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });

  const project = await db.project.upsert({
    where: { id: "demo-project-001" },
    update: {},
    create: {
      id: "demo-project-001",
      organizationId: org.id,
      name: "Launch NexusHub v1",
      description: "All tasks for the initial product launch",
      color: "#6366f1",
    },
  });

  const tasks = [
    { title: "Set up authentication system", status: "DONE" as const, priority: "HIGH" as const },
    { title: "Build project management UI", status: "IN_PROGRESS" as const, priority: "HIGH" as const },
    { title: "Integrate Stripe billing", status: "TODO" as const, priority: "MEDIUM" as const },
    { title: "Write API documentation", status: "BACKLOG" as const, priority: "LOW" as const },
    { title: "Deploy to production", status: "BACKLOG" as const, priority: "URGENT" as const },
  ];

  for (let i = 0; i < tasks.length; i++) {
    await db.task.upsert({
      where: { id: `demo-task-00${i + 1}` },
      update: {},
      create: {
        id: `demo-task-00${i + 1}`,
        projectId: project.id,
        creatorId: user.id,
        assigneeId: user.id,
        ...tasks[i],
        position: (i + 1) * 1000,
      },
    });
  }

  console.log("✅ Seed complete");
  console.log("📧 Login: demo@nexushub.com / Password123!");
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
