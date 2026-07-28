import app from "./app";
import { config } from "./config";
import { APP_NAME } from "./constants";

// ─── Uncaught exceptions — crash immediately ───
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

// ─── Unhandled rejections — log & exit ─────────
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
  process.exit(1);
});

const server = app.listen(config.port, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   ${APP_NAME}
  ║   Running on http://localhost:${config.port}
  ║   Environment: ${config.nodeEnv}
  ╚══════════════════════════════════════════╝
  `);
});

// ─── Graceful shutdown ─────────────────────────
function gracefulShutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    console.log("[SERVER] Closed. Goodbye.");
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error("[SERVER] Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
