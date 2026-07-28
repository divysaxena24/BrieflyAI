import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { config } from "./config";
import { CORS_OPTIONS } from "./constants";
import { errorMiddleware } from "./middleware/error.middleware";
import routes from "./routes";

const app = express();

// ─── Middleware ─────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: config.frontendUrl,
  ...CORS_OPTIONS,
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(morgan(config.isDevelopment ? "dev" : "combined"));

// ─── Health check (no auth required) ───────────
app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "BrieflyAI Backend is running",
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
  });
});

// ─── API Routes ─────────────────────────────────
app.use(routes);

// ─── 404 handler ────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// ─── Error handler ──────────────────────────────
app.use(errorMiddleware);

export default app;
