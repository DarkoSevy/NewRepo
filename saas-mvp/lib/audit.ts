import { db } from "@/lib/db";
import { NextRequest } from "next/server";

interface AuditParams {
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  organizationId?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
  req?: NextRequest;
}

export async function createAuditLog(params: AuditParams) {
  const { userId, action, resource, resourceId, organizationId, projectId, metadata, req } = params;

  await db.auditLog.create({
    data: {
      userId,
      action,
      resource,
      resourceId,
      organizationId,
      projectId,
      metadata: metadata ?? {},
      ipAddress: req?.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? req?.headers.get("x-real-ip") ?? undefined,
      userAgent: req?.headers.get("user-agent") ?? undefined,
    },
  });
}
