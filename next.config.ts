import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Fix workspace root detection with multiple lockfiles */
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
