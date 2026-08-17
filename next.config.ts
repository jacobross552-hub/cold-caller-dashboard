import type { NextConfig } from "next";

// The calling-hours dispatcher is started from src/instrumentation.ts, which
// Next runs automatically on server boot. No extra config needed for that.
const nextConfig: NextConfig = {};

export default nextConfig;
