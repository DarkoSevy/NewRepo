import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Sidebar } from "@/components/dashboard/sidebar";
import { TopBar } from "@/components/dashboard/top-bar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const membership = await db.organizationMember.findFirst({
    where: { userId: session.user.id },
    include: {
      organization: {
        include: { _count: { select: { members: true, projects: true } } },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  if (!membership) redirect("/onboarding");

  return (
    <div className="h-screen flex overflow-hidden bg-gray-50">
      <Sidebar org={membership.organization} userRole={membership.role} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar user={session.user} org={membership.organization} />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
