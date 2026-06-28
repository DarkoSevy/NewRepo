import Stripe from "stripe";
import { db } from "@/lib/db";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
  typescript: true,
});

export const PLANS = {
  FREE: {
    name: "Free",
    price: 0,
    priceId: null,
    limits: { members: 3, projects: 3, storage: 1 },
  },
  PRO: {
    name: "Pro",
    price: 12,
    priceId: process.env.STRIPE_PRO_PRICE_ID,
    limits: { members: 25, projects: 50, storage: 25 },
  },
  ENTERPRISE: {
    name: "Enterprise",
    price: 49,
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID,
    limits: { members: Infinity, projects: Infinity, storage: 100 },
  },
} as const;

export async function getOrCreateCustomer(organizationId: string, email: string) {
  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
  });

  if (org.stripeCustomerId) {
    return stripe.customers.retrieve(org.stripeCustomerId) as Promise<Stripe.Customer>;
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { organizationId },
  });

  await db.organization.update({
    where: { id: organizationId },
    data: { stripeCustomerId: customer.id },
  });

  return customer;
}
