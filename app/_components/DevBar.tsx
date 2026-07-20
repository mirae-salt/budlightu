/**
 * Dev-only top bar for quick navigation between BAM portal + Admin pages.
 * Rendered only when NODE_ENV=development (Next inlines this at build time).
 * Stripped from production builds automatically — no runtime check needed.
 */
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const bamLinks: Array<[string, string]> = [
  ['/',                              'Home'],
  ['/portal/login',                  'Login'],
  ['/portal/dashboard',              'Dashboard'],
  ['/portal/upload',                 'Upload'],
  ['/portal/support',                'Support'],
  ['/portal/faq',                    'FAQ'],
  ['/portal/onboarding/demo-token',  'Onboarding']
]

const adminLinks: Array<[string, string]> = [
  ['/admin',           'Dashboard'],
  ['/admin/receipts',  'Receipts'],
  ['/admin/invoices',  'Invoices'],
  ['/admin/roster',    'Roster'],
  ['/admin/cohorts',   'Cohorts'],
  ['/admin/unmatched', 'Unmatched'],
  ['/admin/audit',     'Audit']
]

export function DevBar() {
  if (process.env.NODE_ENV !== 'development') return null
  const path = usePathname()

  const isActive = (href: string) => path === href || (href !== '/' && path.startsWith(href))

  return (
    <div
      style={{
        position: 'sticky', top: 0, zIndex: 1000,
        background: '#1f2937',
        color: '#fff',
        borderBottom: '2px solid #F79124',
        padding: '4px 12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        overflowX: 'auto',
        whiteSpace: 'nowrap'
      }}
    >
      <span style={{ background: '#F79124', color: '#000', padding: '2px 8px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.5 }}>
        DEV
      </span>

      <NavGroup label="BAM" links={bamLinks} isActive={isActive} color="#7CD7CB" />
      <NavGroup label="ADMIN" links={adminLinks} isActive={isActive} color="#7CB8E6" />

      <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 10 }}>
        NODE_ENV=development · Sonnet OCR · dryrun default
      </span>
    </div>
  )
}

function NavGroup({
  label, links, isActive, color
}: {
  label: string
  links: Array<[string, string]>
  isActive: (href: string) => boolean
  color: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color, fontWeight: 700 }}>{label}</span>
      {links.map(([href, name]) => (
        <Link
          key={href}
          href={href}
          style={{
            color: isActive(href) ? '#fff' : '#9CA3AF',
            textDecoration: 'none',
            padding: '2px 8px',
            borderRadius: 3,
            background: isActive(href) ? 'rgba(255,255,255,0.12)' : 'transparent',
            fontWeight: isActive(href) ? 600 : 400
          }}
        >
          {name}
        </Link>
      ))}
    </div>
  )
}
