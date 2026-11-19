import type { NextConfig } from "next";

// ISA's pages always show live data, so Cache Components is off and pages opt into
// dynamic rendering with `export const dynamic = "force-dynamic"`.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
