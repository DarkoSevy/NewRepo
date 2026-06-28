import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { BillingContent } from "@/components/dashboard/billing-content";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const membership = await db.organizationMember.findFirst({
    where: { userId: session.user.id },
    include: { organization: true },
    orderBy: { joinedAt: "asc" },
  });
  if (!membership) redirect("/login");

  return (
    <BillingContent
      org={membership.organization}
      userRole={membership.role}
    />
  );
}
