import type { NextConfig } from "next";

// Every page is generated at build time from the JSON files in CT_CONTENT_DIR; nothing runs per request.
// The content security policy and headers are SPEC §7 "Security headers". Inline script and style are allowed
// (nonces need per-request rendering); the plain-text rules are the defence. 'unsafe-eval' only outside
// production, for the dev server's React tooling.

/** The Content-Security-Policy value for this NODE_ENV (§7). */
export function contentSecurityPolicy(env: string | undefined = process.env.NODE_ENV): string {
  const script = env === "production" ? "script-src 'self' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  return [
    "default-src 'self'",
    script,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** The five headers every route gets (§7). */
export function securityHeaders(env: string | undefined = process.env.NODE_ENV): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  ];
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export default nextConfig;
