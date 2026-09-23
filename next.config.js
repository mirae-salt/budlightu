/*
 * The content policy, sent as REPORT-ONLY for now.
 *
 * A CodeScan report on 2026-09-15 pointed out that the site has every other
 * security header and no Content-Security-Policy. Turning one on the day before
 * an AP send is how a screen stops rendering with no error anybody can see, so
 * this reports and blocks nothing. Browsers log each violation to the console;
 * that list is what the enforcing version gets built from.
 *
 * The browser only ever talks to two origins: this site and Supabase. Graph,
 * OpenRouter and Resend are all called from the server, so they have no business
 * in a policy the browser enforces.
 *
 * 'unsafe-inline' for script-src is here because Next.js injects its own inline
 * hydration scripts. Removing it means issuing a nonce from middleware, which is
 * a separate change and needs its own verification.
 *
 * 'unsafe-eval' is development only: React Fast Refresh uses eval, and leaving it
 * in would let a real eval in production pass unreported.
 */
function contentPolicy() {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://*.supabase.co'
  const socket = supabase.replace(/^https:/, 'wss:')
  const dev = process.env.NODE_ENV === 'development'

  return [
    "default-src 'self'",
    "base-uri 'self'",
    // 'self', not 'none': a PDF receipt is shown through an <object> tag
    // (app/admin/receipts/page.tsx:606), which is exactly what object-src governs.
    // 'none' would blank that panel out with no error on screen.
    "object-src 'self'",
    "form-action 'self'",
    // 'self' rather than 'none': the receipt image and support attachment routes
    // are framed by our own pages on purpose (see the header group below).
    "frame-ancestors 'self'",
    `img-src 'self' data: blob: ${supabase}`,
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    `connect-src 'self' ${supabase} ${socket}`,
    "frame-src 'self' blob: data:",
    "worker-src 'self' blob:"
  ].join('; ')
}

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
        { key: 'Content-Security-Policy-Report-Only', value: contentPolicy() },
      ]
    }, {
      /*
       * The only two routes that have to be frameable by our own pages.
       *
       * DENY above applies to <object> and <embed> as well as <iframe>, and it applies
       * even when the framing page is us. So a PDF receipt could not be displayed at all:
       * Kennedy Cober's showed as a broken image, and after it was switched to an <object>
       * it showed as nothing, which is worse because there is no broken-image icon to
       * explain it. A browser cannot render a PDF in an <img>, so there is no third option.
       * A support attachment can be a PDF for the same reason.
       *
       * SAMEORIGIN, and only here. Both routes authorize the caller first and return a
       * stored file with no interactive content, so framing one from budlightu.com is the
       * intended use and framing one from anywhere else stays refused. Every page a person
       * actually clicks on is still DENY.
       *
       * Listed after the catch-all on purpose: Next.js applies matching header groups in
       * order and the later one wins for a repeated key.
       */
      source: '/api/:path(admin/receipts/image|portal/support/attachment)',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      ]
    }]
  }
}

module.exports = nextConfig
