import { NextResponse } from "next/server";
import DriveService from "@/lib/services/drive";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { drivePaginationSchema } from "@/lib/validators/drive";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  logger.info("API: GET /api/drive-folders received");
  const url = new URL(request.url);
  const pageSize = url.searchParams.get("pageSize");
  const pageToken = url.searchParams.get("pageToken");

  try {
    const parsed = drivePaginationSchema.parse({ pageSize: pageSize ? Number(pageSize) : undefined, pageToken: pageToken ?? undefined });
    const result = await DriveService.listFolders(parsed.pageSize, parsed.pageToken);
    return NextResponse.json(result);
  } catch (err: any) {
    logger.error("API: /api/drive-folders error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid parameters" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
