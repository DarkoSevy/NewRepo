import { redis } from "@/lib/redis";
import { NextRequest } from "next/server";

interface RateLimitConfig {
  limit: number;
  window: number; // seconds
}

const PRESETS = {
  auth: { limit: 5, window: 60 },
  api: { limit: 100, window: 60 },
  upload: { limit: 10, window: 60 },
} satisfies Record<string, RateLimitConfig>;

export async function rateLimit(
  req: NextRequest,
  preset: keyof typeof PRESETS = "api"
): Promise<{ success: boolean; remaining: number; reset: number }> {
  const { limit, window } = PRESETS[preset];
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const key = `rate_limit:${preset}:${ip}`;
  const now = Date.now();
  const windowStart = now - window * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.zcard(key);
  pipeline.expire(key, window);

  const results = await pipeline.exec();
  const count = (results?.[2]?.[1] as number) ?? 0;

  return {
    success: count <= limit,
    remaining: Math.max(0, limit - count),
    reset: Math.ceil((windowStart + window * 1000) / 1000),
  };
}
