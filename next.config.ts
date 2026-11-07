import type { NextConfig } from "next";

// Every page is generated at build time from the JSON files in CT_CONTENT_DIR; nothing runs per request.
// P4 adds the content security policy (SPEC §7.2).
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
