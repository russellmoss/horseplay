/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      'playwright', 'playwright-core',
      'playwright-extra', 'puppeteer-extra-plugin-stealth',
    ],
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
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
        'clone-deep',
        'merge-deep',
        'electron',
        'bufferutil',
        'utf-8-validate',
      ];
    }
    return cfg;
  },
};

export default config;
