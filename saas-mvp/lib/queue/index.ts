import { Queue, Worker, QueueEvents } from "bullmq";
import { redis } from "@/lib/redis";

const CONNECTION = {
  connection: { host: process.env.REDIS_HOST ?? "localhost", port: 6379 },
};

// ─── Queues ──────────────────────────────────────────────────────────────────

export const emailQueue = new Queue("email", CONNECTION);
export const notificationQueue = new Queue("notification", CONNECTION);
export const analyticsQueue = new Queue("analytics", CONNECTION);

// ─── Job Types ───────────────────────────────────────────────────────────────

export type EmailJob =
  | { type: "welcome"; to: string; name: string }
  | { type: "invitation"; to: string; inviterName: string; orgName: string; token: string }
  | { type: "password-reset"; to: string; token: string };

export type NotificationJob = {
  userId: string;
  type: string;
  title: string;
  body?: string;
  href?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function scheduleEmail(job: EmailJob) {
  return emailQueue.add(job.type, job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

export async function scheduleNotification(job: NotificationJob) {
  return notificationQueue.add("create", job, {
    attempts: 2,
    removeOnComplete: true,
  });
}
