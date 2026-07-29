import { NextResponse } from "next/server";
import { AppError, apiFailure, apiSuccess } from "@/lib/errors";
import { logger } from "@/lib/logger";

export type RouteHandler = (req: Request) => Promise<NextResponse> | Promise<any> | any;

/**
 * Wrap route handlers to centralize error handling and logging.
 * Handler should perform validation and call services and return a plain object or NextResponse.
 */
export function withHandler(handler: RouteHandler) {
  return async function (req: Request) {
    try {
      logger.info("Incoming request", { method: (req as any).method ?? "GET", url: (req as any).url ?? "-" });
      const result = await handler(req);

      // If handler returned an object shaped { message, data }, use message as success message
      if (result && typeof result === "object" && "message" in (result as any) && "data" in (result as any)) {
        const r = result as { message?: string; data?: any };
        return NextResponse.json(apiSuccess(r.data ?? null, r.message ?? "OK"), { status: 200 });
      }

      // If handler returned a NextResponse-like object, forward it (best-effort)
      if (result && typeof result === "object" && typeof (result as any).json === "function") {
        return result;
      }

      // Otherwise assume it's plain data to wrap as success
      return NextResponse.json(apiSuccess(result ?? null, "OK"), { status: 200 });
    } catch (err) {
      // Known AppError -> standardized response
      if (err instanceof AppError) {
        logger.warn("Handled AppError", { message: err.message, code: err.code, status: err.status, details: err.details });
        return NextResponse.json(apiFailure(err.message, [{ message: err.message, code: err.code, details: err.details }]), { status: err.status });
      }

      // Unknown error
      logger.error("Unhandled error in route handler", err);
      return NextResponse.json(apiFailure("Internal Server Error", [{ message: (err as any)?.message ?? "Unknown" }]), { status: 500 });
    }
  };
}

export default withHandler;
