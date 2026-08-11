import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // API-only MCP server: no React pages are served at runtime, only route
  // handlers under app/. Kept intentionally minimal.
  reactStrictMode: true,
  // Linting is handled by the standalone `npm run lint` (flat ESLint config),
  // which the CI pipeline runs as its own step. Next 16 no longer runs (or
  // configures) ESLint during `next build`, so there is nothing to opt out of.
  // Pin file-tracing to this project so a stray parent lockfile can't make
  // Next infer the wrong workspace root (affects Vercel's bundled output).
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
