import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { registerSchema } from "@/lib/validations/auth";
import { created, handleError, ApiError } from "@/lib/api-response";
import { sendWelcomeEmail } from "@/lib/email";
import { slugify } from "@/lib/utils";

export async function POST(req: NextRequest) {
  try {
    const limit = await rateLimit(req, "auth");
    if (!limit.success) return ApiError.tooManyRequests();

    const body = await req.json();
    const data = registerSchema.parse(body);

    const exists = await db.user.findUnique({ where: { email: data.email } });
    if (exists) return ApiError.conflict("Email already in use");

    const passwordHash = await bcrypt.hash(data.password, 12);
    const slug = await generateUniqueSlug(data.organizationName);

    const user = await db.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          passwordHash,
        },
      });

      const org = await tx.organization.create({
        data: {
          name: data.organizationName,
          slug,
          members: {
            create: {
              userId: newUser.id,
              role: "OWNER",
            },
          },
        },
      });

      return { ...newUser, defaultOrganizationId: org.id };
    });

    await sendWelcomeEmail({ to: user.email!, name: user.name! }).catch(console.error);

    return created({
      id: user.id,
      name: user.name,
      email: user.email,
      organizationId: user.defaultOrganizationId,
    });
  } catch (err) {
    return handleError(err);
  }
}

async function generateUniqueSlug(name: string): Promise<string> {
  let slug = slugify(name);
  let suffix = 0;

  while (true) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix}`;
    const existing = await db.organization.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
    suffix++;
  }
}
