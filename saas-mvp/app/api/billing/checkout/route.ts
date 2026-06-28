import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripe, PLANS, getOrCreateCustomer } from "@/lib/stripe";
import { ok, handleError, ApiError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  organizationId: z.string().cuid(),
  plan: z.enum(["PRO", "ENTERPRISE"]),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const body = await req.json();
    const { organizationId, plan } = schema.parse(body);

    const member = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: session.id } },
      include: { user: true },
    });
    if (!member || member.role !== "OWNER") return ApiError.forbidden();

    const priceId = PLANS[plan].priceId;
    if (!priceId) return ApiError.badRequest("Invalid plan");

    const customer = await getOrCreateCustomer(organizationId, member.user.email!);

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing?canceled=true`,
      metadata: { organizationId, plan },
      subscription_data: {
        trial_period_days: 14,
        metadata: { organizationId },
      },
    });

    return ok({ url: checkoutSession.url });
  } catch (err) {
    return handleError(err);
  }
}
