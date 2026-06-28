/**
 * Background worker process — runs separately from Next.js server.
 * Start with: npx tsx worker.ts
 * In production: node worker.js (after build)
 */

import { Worker } from "bullmq";
import { db } from "@/lib/db";
import { sendWelcomeEmail, sendInvitationEmail, sendPasswordResetEmail } from "@/lib/email";
import type { EmailJob, NotificationJob } from "@/lib/queue";

const CONNECTION = {
  connection: { host: process.env.REDIS_HOST ?? "localhost", port: 6379 },
};

console.log("🚀 Worker starting...");

// Email worker
const emailWorker = new Worker<EmailJob>(
  "email",
  async (job) => {
    const data = job.data;
    switch (data.type) {
      case "welcome":
        await sendWelcomeEmail({ to: data.to, name: data.name });
        break;
      case "invitation":
        await sendInvitationEmail({
          to: data.to,
          inviterName: data.inviterName,
          organizationName: data.orgName,
          token: data.token,
        });
        break;
      case "password-reset":
        await sendPasswordResetEmail({ to: data.to, token: data.token });
        break;
    }
  },
  { ...CONNECTION, concurrency: 5 }
);

// Notification worker
const notificationWorker = new Worker<NotificationJob>(
  "notification",
  async (job) => {
    const { userId, type, title, body, href } = job.data;
    await db.notification.create({
      data: { userId, type: type as any, title, body, href },
    });
  },
  { ...CONNECTION, concurrency: 10 }
);

emailWorker.on("completed", (job) => console.log(`[email] ✓ ${job.id}`));
emailWorker.on("failed", (job, err) => console.error(`[email] ✗ ${job?.id}`, err.message));
notificationWorker.on("failed", (job, err) => console.error(`[notification] ✗ ${job?.id}`, err.message));

process.on("SIGTERM", async () => {
  await emailWorker.close();
  await notificationWorker.close();
  process.exit(0);
});
