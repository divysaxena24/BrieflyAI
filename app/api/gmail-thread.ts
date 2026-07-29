import { NextResponse } from "next/server";
import GmailService from "@/lib/services/gmail";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  logger.info("API: GET /api/gmail-thread received", { threadId: id });
  if (!id) return NextResponse.json({ message: "Missing thread id" }, { status: 400 });

  try {
    const thread = await GmailService.getThread(id);
    return NextResponse.json(thread);
  } catch (err: any) {
    logger.error("API: /api/gmail-thread error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
