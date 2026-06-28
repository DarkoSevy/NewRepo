import Link from "next/link";
import { ArrowRight, CheckCircle2, Layers, Users, Zap, BarChart3, Shield, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const FEATURES = [
  {
    icon: Layers,
    title: "Multi-tenant Architecture",
    description: "Isolated workspaces for every team. Your data stays yours.",
  },
  {
    icon: Users,
    title: "Real-time Collaboration",
    description: "Work together seamlessly with live updates and notifications.",
  },
  {
    icon: Zap,
    title: "Blazing Fast",
    description: "Built on Next.js 14 with optimistic updates and edge caching.",
  },
  {
    icon: BarChart3,
    title: "Analytics & Insights",
    description: "Understand your team's velocity and project health at a glance.",
  },
  {
    icon: Shield,
    title: "Enterprise Security",
    description: "SOC 2 ready, audit logs, RBAC, and SSO support.",
  },
  {
    icon: Globe,
    title: "Built to Scale",
    description: "Redis caching, queue workers, and CDN-ready assets.",
  },
];

const PRICING = [
  {
    name: "Free",
    price: 0,
    description: "Perfect for small teams getting started",
    features: ["3 projects", "3 team members", "1 GB storage", "Community support"],
    cta: "Get started free",
    variant: "outline" as const,
  },
  {
    name: "Pro",
    price: 12,
    description: "For growing teams that need more power",
    features: ["50 projects", "25 team members", "25 GB storage", "Priority support", "Advanced analytics", "Custom fields"],
    cta: "Start free trial",
    variant: "default" as const,
    popular: true,
  },
  {
    name: "Enterprise",
    price: 49,
    description: "For large organizations with custom needs",
    features: ["Unlimited projects", "Unlimited members", "100 GB storage", "24/7 support", "SSO / SAML", "SLA guarantee", "Audit logs"],
    cta: "Contact sales",
    variant: "outline" as const,
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col min-h-screen bg-white">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b bg-white/80 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <Layers className="h-4 w-4 text-white" />
            </div>
            <span className="text-xl font-bold text-gray-900">NexusHub</span>
          </div>
          <nav className="hidden md:flex items-center gap-8 text-sm text-gray-600">
            <a href="#features" className="hover:text-gray-900 transition-colors">Features</a>
            <a href="#pricing" className="hover:text-gray-900 transition-colors">Pricing</a>
            <a href="#" className="hover:text-gray-900 transition-colors">Docs</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost" size="sm">Sign in</Button>
            </Link>
            <Link href="/register">
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700">
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative py-24 px-6 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-white to-purple-50" />
          <div className="absolute top-20 right-10 w-72 h-72 bg-indigo-200 rounded-full blur-3xl opacity-30" />
          <div className="absolute bottom-10 left-10 w-96 h-96 bg-purple-200 rounded-full blur-3xl opacity-20" />

          <div className="relative container mx-auto text-center max-w-4xl">
            <Badge className="mb-6 bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-50">
              ✨ Now with AI-powered task suggestions
            </Badge>
            <h1 className="text-5xl md:text-7xl font-extrabold text-gray-900 tracking-tight leading-tight mb-6">
              Ship faster with{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-purple-600">
                your entire team
              </span>
            </h1>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-10 leading-relaxed">
              NexusHub is the all-in-one project management platform that helps engineering teams
              plan, track, and ship — without the complexity.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/register">
                <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 h-12">
                  Start for free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Button size="lg" variant="outline" className="px-8 h-12">
                Watch demo
              </Button>
            </div>
            <p className="mt-4 text-sm text-gray-500">No credit card required · 14-day free trial on Pro</p>
          </div>
        </section>

        {/* Social proof */}
        <section className="py-12 border-y bg-gray-50">
          <div className="container mx-auto px-6 text-center">
            <p className="text-sm text-gray-500 mb-8">Trusted by engineering teams at</p>
            <div className="flex flex-wrap justify-center gap-12 items-center opacity-50 grayscale">
              {["Acme Corp", "TechFlow", "DevScale", "BuildFast", "CloudNine"].map((name) => (
                <span key={name} className="text-xl font-bold text-gray-800">{name}</span>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="py-24 px-6">
          <div className="container mx-auto max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-4xl font-bold text-gray-900 mb-4">Everything your team needs</h2>
              <p className="text-lg text-gray-600 max-w-2xl mx-auto">
                Built for teams that move fast, NexusHub gives you the tools to stay organized without slowing down.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="p-6 rounded-2xl border border-gray-100 hover:border-indigo-200 hover:shadow-lg transition-all group">
                  <div className="w-12 h-12 rounded-xl bg-indigo-50 group-hover:bg-indigo-100 flex items-center justify-center mb-4 transition-colors">
                    <feature.icon className="h-6 w-6 text-indigo-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">{feature.title}</h3>
                  <p className="text-gray-600 text-sm leading-relaxed">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="py-24 px-6 bg-gray-50">
          <div className="container mx-auto max-w-5xl">
            <div className="text-center mb-16">
              <h2 className="text-4xl font-bold text-gray-900 mb-4">Simple, transparent pricing</h2>
              <p className="text-lg text-gray-600">No hidden fees. Cancel anytime.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {PRICING.map((plan) => (
                <div
                  key={plan.name}
                  className={`relative p-8 rounded-2xl border-2 bg-white flex flex-col ${
                    plan.popular
                      ? "border-indigo-600 shadow-xl shadow-indigo-100"
                      : "border-gray-100"
                  }`}
                >
                  {plan.popular && (
                    <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-indigo-600 text-white border-0">
                      Most Popular
                    </Badge>
                  )}
                  <div className="mb-6">
                    <h3 className="text-xl font-bold text-gray-900">{plan.name}</h3>
                    <p className="text-gray-500 text-sm mt-1">{plan.description}</p>
                    <div className="mt-4 flex items-baseline gap-1">
                      <span className="text-4xl font-extrabold text-gray-900">${plan.price}</span>
                      {plan.price > 0 && <span className="text-gray-500">/user/mo</span>}
                    </div>
                  </div>
                  <ul className="space-y-3 flex-1 mb-8">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-center gap-2 text-sm text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-indigo-600 shrink-0" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Link href="/register">
                    <Button
                      variant={plan.variant}
                      className={`w-full ${plan.popular ? "bg-indigo-600 hover:bg-indigo-700 text-white border-0" : ""}`}
                    >
                      {plan.cta}
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-24 px-6">
          <div className="container mx-auto max-w-3xl text-center">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">
              Ready to build something great?
            </h2>
            <p className="text-lg text-gray-600 mb-8">
              Join thousands of teams using NexusHub to ship faster.
            </p>
            <Link href="/register">
              <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 h-12">
                Get started for free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t py-12 bg-gray-50">
        <div className="container mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center">
              <Layers className="h-3 w-3 text-white" />
            </div>
            <span className="font-bold text-gray-800">NexusHub</span>
          </div>
          <p className="text-sm text-gray-500">© 2025 NexusHub. All rights reserved.</p>
          <div className="flex gap-6 text-sm text-gray-500">
            <a href="#" className="hover:text-gray-900">Privacy</a>
            <a href="#" className="hover:text-gray-900">Terms</a>
            <a href="#" className="hover:text-gray-900">Status</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
