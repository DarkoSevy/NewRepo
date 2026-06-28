# NexusHub — System Architecture

## Overview

NexusHub is a **multi-tenant SaaS project management platform** built as a production-ready startup MVP. Architecture follows a **modular monolith** pattern — simple to deploy now, trivially splittable into microservices at scale.

---

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER                              │
│   Browser  ──►  CDN (Cloudflare/Vercel Edge)  ──►  Next.js App     │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │   Auth   │ │   API    │ │ Webhooks │
              │(NextAuth)│ │ Routes   │ │ (Stripe) │
              └──────────┘ └──────────┘ └──────────┘
                    │             │             │
          ┌─────────┼─────────────┼─────────────┘
          │         │             │
          ▼         ▼             ▼
    ┌──────────┐ ┌──────┐  ┌──────────┐
    │ Prisma   │ │Redis │  │  BullMQ  │
    │   ORM    │ │Cache │  │  Worker  │
    └──────────┘ └──────┘  └──────────┘
          │                      │
          ▼                      ▼
    ┌──────────┐           ┌──────────┐
    │ Postgres │           │  Resend  │
    │    DB    │           │  Email   │
    └──────────┘           └──────────┘
```

---

## File Structure

```
saas-mvp/
├── app/                          # Next.js 14 App Router
│   ├── (auth)/                   # Auth route group (no shared layout)
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   ├── (dashboard)/              # Protected dashboard group
│   │   ├── layout.tsx            # Auth check + sidebar layout
│   │   ├── dashboard/page.tsx    # Home dashboard
│   │   ├── projects/
│   │   │   ├── page.tsx          # Project list
│   │   │   └── [id]/page.tsx     # Kanban board
│   │   ├── settings/page.tsx
│   │   └── billing/page.tsx      # Stripe billing UI
│   ├── api/                      # API route handlers
│   │   ├── auth/[...nextauth]/   # NextAuth.js handler
│   │   ├── auth/register/        # Custom register (bcrypt)
│   │   ├── users/me/             # Current user CRUD
│   │   ├── organizations/        # Org management
│   │   │   └── [id]/members/     # Member invite/remove
│   │   ├── projects/             # Project CRUD
│   │   │   └── [id]/tasks/       # Task CRUD per project
│   │   ├── tasks/[id]/           # Individual task updates
│   │   ├── billing/
│   │   │   ├── checkout/         # Stripe checkout session
│   │   │   └── portal/           # Stripe billing portal
│   │   └── webhooks/stripe/      # Stripe event processing
│   ├── layout.tsx                # Root layout (fonts, metadata)
│   ├── page.tsx                  # Landing page
│   └── globals.css               # Tailwind + CSS variables
├── components/
│   ├── ui/                       # Headless shadcn/ui primitives
│   ├── auth/                     # Login, Register forms
│   └── dashboard/                # Sidebar, TopBar, page content
├── lib/
│   ├── auth.ts                   # NextAuth config + helpers
│   ├── db.ts                     # Prisma singleton
│   ├── stripe.ts                 # Stripe client + plan config
│   ├── redis.ts                  # ioredis singleton
│   ├── email.ts                  # Resend email templates
│   ├── rate-limit.ts             # Sliding window rate limiter
│   ├── audit.ts                  # Audit log writer
│   ├── api-response.ts           # Typed response helpers
│   ├── utils.ts                  # cn(), slugify(), etc.
│   ├── queue/index.ts            # BullMQ queue definitions
│   └── validations/              # Zod schemas (auth, project, task)
├── hooks/
│   └── use-toast.ts              # Toast state machine
├── prisma/
│   ├── schema.prisma             # Full DB schema
│   └── seed.ts                   # Demo data seeder
├── middleware.ts                 # Route protection + redirects
├── worker.ts                     # BullMQ worker process
├── Dockerfile                    # Multi-stage production build
├── docker-compose.yml            # Full stack (app + db + redis + worker)
└── .env.example                  # All env vars documented
```

---

## Database Schema

### Core entities and relationships:

```
User ──────────────────────► OrganizationMember ◄──── Organization
  │                               (role: OWNER/ADMIN/MEMBER/VIEWER)
  │
  ├──► Task (creator)
  ├──► Task (assignee)
  └──► Comment, AuditLog, Notification

Organization ──► Project ──► Task ──► Comment
                    │          │      └──► Attachment
                    └► Label ◄─┘
```

### Key design decisions:
- **Multi-tenancy via `organizationId`** on every resource — no shared data leakage
- **Soft position float** for kanban drag-and-drop (lexicographic insertion, no rewrite)
- **Audit logs** on every mutation — compliance-ready
- **Stripe IDs on Organization** — one Stripe customer per workspace (not per user)

---

## API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/auth/register` | Register + create org | Public |
| GET/PATCH | `/api/users/me` | Current user profile | User |
| GET/POST | `/api/organizations` | List / create orgs | User |
| GET/PATCH/DELETE | `/api/organizations/:id` | Org CRUD | Member |
| GET/POST/DELETE | `/api/organizations/:id/members` | Manage members | Member |
| GET/POST | `/api/projects` | List / create projects | Member |
| GET/PATCH/DELETE | `/api/projects/:id` | Project CRUD | Member |
| GET/POST | `/api/projects/:id/tasks` | Tasks per project | Member |
| GET/PATCH/DELETE | `/api/tasks/:id` | Task CRUD | Member |
| POST | `/api/billing/checkout` | Stripe checkout | Owner |
| POST | `/api/billing/portal` | Stripe portal | Owner |
| POST | `/api/webhooks/stripe` | Stripe events | Stripe HMAC |

---

## Scaling Plan

### Phase 1 — MVP (1-1K users)
- Single Next.js deployment (Vercel / Railway / Render)
- Managed PostgreSQL (Neon / Supabase / Railway)
- Managed Redis (Upstash)
- BullMQ worker as separate process

### Phase 2 — Growth (1K-100K users)
- Add read replicas to PostgreSQL
- Redis cluster for session + cache
- Move to connection pooling (PgBouncer / Prisma Accelerate)
- CDN for static assets (already configured)
- Add OpenTelemetry traces (Axiom / Datadog)

### Phase 3 — Scale (100K+ users)
- Split API into dedicated microservices (notifications, billing, search)
- Add Elasticsearch / Typesense for full-text search
- Add WebSocket server for real-time (Ably / Pusher / Soketi)
- Database sharding by `organizationId`
- Edge functions for auth (Clerk / WorkOS)

---

## Security Checklist

- [x] JWT sessions (httpOnly cookies via NextAuth)
- [x] bcrypt password hashing (cost 12)
- [x] Zod input validation on every endpoint
- [x] Rate limiting on auth endpoints (5 req/min per IP)
- [x] Stripe webhook signature verification
- [x] RBAC (Owner/Admin/Member/Viewer) enforced server-side
- [x] Audit logs for all mutations
- [x] Security headers (X-Frame-Options, CSP-ready, nosniff)
- [x] No user data leakage across organizations
- [ ] CSP header (configure per environment)
- [ ] SOC 2 controls (implement at Phase 2)
- [ ] SSO / SAML (Enterprise tier, Phase 2)
