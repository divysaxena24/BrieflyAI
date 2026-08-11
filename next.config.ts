import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Fix workspace root detection with multiple lockfiles */
  turbopack: {
    root: process.cwd(),
  },
  output: "standalone",
  /**
   * Optional runtime image libraries used by Baileys for media thumbnails.
   * Baileys itself must stay BUNDLED: it is ESM-only, and externalizing it
   * makes Turbopack wrap its importers (whatsappProvider) as async modules,
   * breaking the registry's synchronous require(). jimp is installed; sharp
   * is external and simply absent at runtime (Baileys falls back to jimp).
   */
  serverExternalPackages: [
    "jimp",
    "sharp",
  ],
};

export default nextConfig;
