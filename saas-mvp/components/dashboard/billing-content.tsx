"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, ExternalLink, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { PLANS } from "@/lib/stripe";
import type { Organization, MemberRole } from "@prisma/client";

interface BillingContentProps {
  org: Organization;
  userRole: MemberRole;
}

const PLAN_KEYS = ["FREE", "PRO", "ENTERPRISE"] as const;
const PLAN_FEATURES = {
  FREE: ["3 projects", "3 team members", "1 GB storage", "Community support"],
  PRO: ["50 projects", "25 team members", "25 GB storage", "Priority support", "Advanced analytics", "Custom fields"],
  ENTERPRISE: ["Unlimited projects", "Unlimited members", "100 GB storage", "24/7 support", "SSO / SAML", "SLA guarantee", "Audit logs"],
};

export function BillingContent({ org, userRole }: BillingContentProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const isOwner = userRole === "OWNER";

  async function handleUpgrade(plan: "PRO" | "ENTERPRISE") {
    if (!isOwner) return;
    setIsLoading(plan);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: org.id, plan }),
      });
      const data = await res.json();
      if (data.data?.url) {
        window.location.href = data.data.url;
      }
    } catch {
      toast({ title: "Something went wrong", variant: "destructive" });
    } finally {
      setIsLoading(null);
    }
  }

  async function handleManage() {
    if (!isOwner) return;
    setIsLoading("portal");
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: org.id }),
      });
      const data = await res.json();
      if (data.data?.url) {
        window.location.href = data.data.url;
      }
    } catch {
      toast({ title: "Something went wrong", variant: "destructive" });
    } finally {
      setIsLoading(null);
    }
  }

  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
        <p className="text-gray-500 mt-0.5">Manage your subscription and billing</p>
      </div>

      {/* Current plan */}
      <Card className="border-indigo-200 bg-indigo-50/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                Current Plan
                <Badge className="bg-indigo-600 text-white border-0">{org.plan}</Badge>
              </CardTitle>
              <CardDescription className="mt-1">
                {org.subscriptionStatus === "TRIALING"
                  ? `Trial ends ${org.trialEndsAt ? new Date(org.trialEndsAt).toLocaleDateString() : "soon"}`
                  : org.subscriptionStatus === "ACTIVE"
                  ? "Your subscription is active"
                  : "Upgrade to unlock more features"}
              </CardDescription>
            </div>
            {org.stripeCustomerId && isOwner && (
              <Button variant="outline" onClick={handleManage} disabled={isLoading === "portal"}>
                {isLoading === "portal" ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <ExternalLink className="h-4 w-4 mr-2" />
                )}
                Manage billing
              </Button>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* Plan comparison */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Plans</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLAN_KEYS.map((planKey) => {
            const plan = PLANS[planKey];
            const isCurrent = org.plan === planKey;
            const isUpgrade = PLAN_KEYS.indexOf(planKey) > PLAN_KEYS.indexOf(org.plan);

            return (
              <Card
                key={planKey}
                className={`relative ${isCurrent ? "border-indigo-400 ring-1 ring-indigo-400" : "border-gray-100"}`}
              >
                {isCurrent && (
                  <div className="absolute -top-3 left-4">
                    <Badge className="bg-indigo-600 text-white border-0 text-xs">Current Plan</Badge>
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="text-lg">{plan.name}</CardTitle>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-3xl font-bold text-gray-900">${plan.price}</span>
                    {plan.price > 0 && <span className="text-gray-500 text-sm">/user/mo</span>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="space-y-2">
                    {PLAN_FEATURES[planKey].map((feature) => (
                      <li key={feature} className="flex items-center gap-2 text-sm text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-indigo-600 shrink-0" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  {isOwner && isUpgrade && planKey !== "FREE" && (
                    <Button
                      className="w-full bg-indigo-600 hover:bg-indigo-700"
                      onClick={() => handleUpgrade(planKey as "PRO" | "ENTERPRISE")}
                      disabled={!!isLoading}
                    >
                      {isLoading === planKey ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <Zap className="h-4 w-4 mr-2" />
                      )}
                      Upgrade to {plan.name}
                    </Button>
                  )}
                  {isCurrent && (
                    <Button variant="outline" className="w-full" disabled>
                      Current plan
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
