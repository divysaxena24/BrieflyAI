import { Request, Response, NextFunction } from "express";

/**
 * Custom request logging middleware.
 * Currently delegates to morgan in app.ts.
 * Future: add structured logging (winston/pino) and request IDs here.
 */
export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[${req.method}] ${req.originalUrl} — ${res.statusCode} (${duration}ms)`);
  });

  next();
}
