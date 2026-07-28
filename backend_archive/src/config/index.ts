import dotenv from "dotenv";
import path from "path";

// Load .env from the backend root
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

interface EnvConfig {
  port: number;
  nodeEnv: string;
  frontendUrl: string;
  isProduction: boolean;
  isDevelopment: boolean;
}

function getEnvVar(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config: EnvConfig = {
  port: parseInt(getEnvVar("PORT", "5000"), 10),
  nodeEnv: getEnvVar("NODE_ENV", "development"),
  frontendUrl: getEnvVar("FRONTEND_URL", "http://localhost:3000"),
  get isProduction(): boolean {
    return this.nodeEnv === "production";
  },
  get isDevelopment(): boolean {
    return this.nodeEnv === "development";
  },
};
