import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
}

export function created<T>(data: T) {
  return ok(data, 201);
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function error(message: string, status: number, code?: string) {
  return NextResponse.json({ error: { message, code } }, { status });
}

export const ApiError = {
  unauthorized: () => error("Unauthorized", 401, "UNAUTHORIZED"),
  forbidden: () => error("Forbidden", 403, "FORBIDDEN"),
  notFound: (resource = "Resource") => error(`${resource} not found`, 404, "NOT_FOUND"),
  conflict: (message = "Conflict") => error(message, 409, "CONFLICT"),
  badRequest: (message = "Bad request") => error(message, 400, "BAD_REQUEST"),
  tooManyRequests: () => error("Too many requests", 429, "RATE_LIMITED"),
  internal: () => error("Internal server error", 500, "INTERNAL_ERROR"),
};

export function handleError(err: unknown) {
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: { message: "Validation error", code: "VALIDATION_ERROR", details: err.flatten() } },
      { status: 422 }
    );
  }
  if (err instanceof Error) {
    if (err.message === "UNAUTHORIZED") return ApiError.unauthorized();
    if (err.message === "FORBIDDEN") return ApiError.forbidden();
    if (err.message === "NOT_FOUND") return ApiError.notFound();
    console.error("[API Error]", err);
  }
  return ApiError.internal();
}
