import { NextResponse } from "next/server";
import GmailService from "@/lib/services/gmail";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { gmailIdSchema } from "@/lib/validators/gmail";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  logger.info("API: GET /api/gmail-message received", { messageId: id });
  try {
    const parsed = gmailIdSchema.parse(id);
    const message = await GmailService.getMessage(parsed);
    return NextResponse.json(message);
  } catch (err: any) {
    logger.error("API: /api/gmail-message error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid message id" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
