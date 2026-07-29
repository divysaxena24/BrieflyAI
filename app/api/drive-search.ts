import { NextResponse } from "next/server";
import DriveService from "@/lib/services/drive";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { driveSearchSchema } from "@/lib/validators/drive";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const pageSize = url.searchParams.get("pageSize");
  const pageToken = url.searchParams.get("pageToken");

  logger.info("API: GET /api/drive-search received", { q });
  try {
    const parsed = driveSearchSchema.parse({ query: q, pageSize: pageSize ? Number(pageSize) : undefined });
    const result = await DriveService.searchFiles(parsed.query, parsed.pageSize ?? 20, pageToken ?? undefined);
    return NextResponse.json(result);
  } catch (err: any) {
    logger.error("API: /api/drive-search error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid query" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
