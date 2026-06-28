import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import Stripe from "stripe";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

const PLAN_MAP: Record<string, "FREE" | "PRO" | "ENTERPRISE"> = {
  [process.env.STRIPE_PRO_PRICE_ID ?? ""]: "PRO",
  [process.env.STRIPE_ENTERPRISE_PRICE_ID ?? ""]: "ENTERPRISE",
};

const STATUS_MAP: Record<Stripe.Subscription.Status, "ACTIVE" | "INACTIVE" | "PAST_DUE" | "CANCELED" | "TRIALING"> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  unpaid: "PAST_DUE",
  incomplete: "INACTIVE",
  incomplete_expired: "INACTIVE",
  paused: "INACTIVE",
};

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) return NextResponse.json({ error: "No signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const cs = event.data.object as Stripe.CheckoutSession;
        if (cs.mode !== "subscription") break;

        const organizationId = cs.metadata?.organizationId;
        if (!organizationId) break;

        const subscription = await stripe.subscriptions.retrieve(cs.subscription as string);
        const priceId = subscription.items.data[0]?.price.id ?? "";

        await db.organization.update({
          where: { id: organizationId },
          data: {
            stripeSubscriptionId: subscription.id,
            stripePriceId: priceId,
            stripeCustomerId: cs.customer as string,
            plan: PLAN_MAP[priceId] ?? "FREE",
            subscriptionStatus: STATUS_MAP[subscription.status] ?? "INACTIVE",
            trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
          },
        });
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const org = await db.organization.findUnique({
          where: { stripeSubscriptionId: sub.id },
        });
        if (!org) break;

        const priceId = sub.items.data[0]?.price.id ?? "";

        await db.organization.update({
          where: { id: org.id },
          data: {
            plan: PLAN_MAP[priceId] ?? "FREE",
            subscriptionStatus: STATUS_MAP[sub.status] ?? "INACTIVE",
            stripePriceId: priceId,
            trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          },
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await db.organization.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: { plan: "FREE", subscriptionStatus: "CANCELED" },
        });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await db.organization.updateMany({
          where: { stripeSubscriptionId: invoice.subscription as string },
          data: { subscriptionStatus: "PAST_DUE" },
        });
        break;
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[Stripe Webhook Error]", err);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
