import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native canvas (renders scanned PDF pages and shrinks photos for Groq) and the PDF reader that loads it
  // must be required from node_modules, not bundled.
  serverExternalPackages: ['@napi-rs/canvas', 'unpdf'],
};

export default nextConfig;
