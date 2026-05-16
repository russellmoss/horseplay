/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: {
    // Mark Playwright as a server-only dep so the App Router doesn't try to
    // bundle it into client / RSC code paths.
    serverComponentsExternalPackages: ['playwright', 'playwright-core'],
    // Enable instrumentation.ts boot hook.
    instrumentationHook: true,
  },
  // Webpack-level externals: instrumentation.ts and API route handlers go
  // through webpack, and webpack can't resolve Playwright's Node-only deps
  // (`net`, `electron`, `bufferutil`, `utf-8-validate`). Marking these as
  // externals leaves them as runtime `require()` calls instead of trying to
  // bundle them.
  webpack: (cfg, { isServer }) => {
    if (isServer) {
      const externals = Array.isArray(cfg.externals)
        ? cfg.externals
        : cfg.externals
          ? [cfg.externals]
          : [];
      cfg.externals = [
        ...externals,
        // Playwright itself
        'playwright',
        'playwright-core',
        // Optional native deps Playwright probes for and we don't need
        'electron',
        'bufferutil',
        'utf-8-validate',
      ];
    }
    return cfg;
  },
};

export default config;
