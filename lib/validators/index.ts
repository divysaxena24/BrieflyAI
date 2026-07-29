// Central validator utilities
import { z } from "zod";
import { ValidationError } from "@/lib/errors";

export function validateSchema<T>(schema: z.ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new ValidationError("Invalid request payload", res.error.format());
  }
  return res.data as T;
}

export * from "./auth";
export * from "./integrations";
export * from "./gmail";
export * from "./github";
export * from "./calendar";
export * from "./ai";
export * from "./notifications";
