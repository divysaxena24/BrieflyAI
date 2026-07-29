import { NextResponse } from "next/server";
import GmailService from "@/lib/services/gmail";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { gmailThreadIdSchema } from "@/lib/validators/gmail";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  logger.info("API: GET /api/gmail-thread received", { threadId: id });
  try {
    const parsed = gmailThreadIdSchema.parse(id);
    const thread = await GmailService.getThread(parsed);
    return NextResponse.json(thread);
  } catch (err: any) {
    logger.error("API: /api/gmail-thread error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid thread id" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
