/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '15mb' } // receipt uploads
  },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        { key: 'X-DNS-Prefetch-Control', value: 'on' },
      ]
    }, {
      /*
       * The one route that has to be frameable by our own pages.
       *
       * DENY above applies to <object> and <embed> as well as <iframe>, and it applies
       * even when the framing page is us. So a PDF receipt could not be displayed at all:
       * Kennedy Cober's showed as a broken image, and after it was switched to an <object>
       * it showed as nothing, which is worse because there is no broken-image icon to
       * explain it. A browser cannot render a PDF in an <img>, so there is no third option.
       *
       * SAMEORIGIN, and only here. This route is admin-only (requireAdmin) and returns a
       * stored file with no interactive content, so framing it from budlightu.com is the
       * intended use and framing it from anywhere else stays refused. Every page a person
       * actually clicks on is still DENY.
       *
       * Listed after the catch-all on purpose: Next.js applies matching header groups in
       * order and the later one wins for a repeated key.
       */
      source: '/api/admin/receipts/image',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      ]
    }]
  }
}

module.exports = nextConfig
