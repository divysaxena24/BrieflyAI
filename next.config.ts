import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Fix workspace root detection with multiple lockfiles */
  turbopack: {
    root: process.cwd(),
  },
  output: "standalone",
};

export default nextConfig;
