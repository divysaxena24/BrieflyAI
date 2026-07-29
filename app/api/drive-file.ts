import { NextResponse } from "next/server";
import DriveService from "@/lib/services/drive";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { driveFileIdSchema } from "@/lib/validators/drive";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  logger.info("API: GET /api/drive-file received", { fileId: id });
  try {
    const parsed = driveFileIdSchema.parse(id);
    const file = await DriveService.getFile(parsed);
    return NextResponse.json(file);
  } catch (err: any) {
    logger.error("API: /api/drive-file error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid file id" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
