import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { ok, handleError, ApiError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({ organizationId: z.string().cuid() });

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { organizationId } = schema.parse(await req.json());

    const member = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: session.id } },
      include: { organization: true },
    });
    if (!member || member.role !== "OWNER") return ApiError.forbidden();

    const { stripeCustomerId } = member.organization;
    if (!stripeCustomerId) return ApiError.badRequest("No billing account found");

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
    });

    return ok({ url: portalSession.url });
  } catch (err) {
    return handleError(err);
  }
}
