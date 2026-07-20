/**
 * Admin sidebar — sectioned nav with icons.
 * Mirrors the reference layout structure with Salt XC palette.
 */
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

type NavItem = { href: string; label: string; icon: JSX.Element; badge?: string }
type NavGroup = { title: string; items: NavItem[] }

const groups: NavGroup[] = [
  {
    title: 'Program',
    items: [
      { href: '/admin',           label: 'Dashboard', icon: <IconGrid /> },
      { href: '/admin/receipts',  label: 'Receipts',  icon: <IconReceipt />, badge: '0' },
      { href: '/admin/invoices',  label: 'Invoices',  icon: <IconFile /> }
    ]
  },
  {
    title: 'Roster',
    items: [
      { href: '/admin/roster',    label: 'BAMs',       icon: <IconUsers /> },
      { href: '/admin/cohorts',   label: 'Cohorts',    icon: <IconLayers /> },
      { href: '/admin/unmatched', label: 'Unmatched',  icon: <IconAlert /> }
    ]
  },
  {
    title: 'System',
    items: [
      { href: '/admin/audit',     label: 'Audit log',  icon: <IconShield /> }
    ]
  }
]

export function Sidebar() {
  const path = usePathname()
  return (
    <aside className="sidebar">
      <div className="sidebar-brand" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, paddingBottom: 16 }}>
        <img src="/brand/bud-light-wordmark.svg" alt="Bud Light" style={{ height: 42, width: 'auto' }} />
        <div className="muted" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
          U · Admin console
        </div>
      </div>

      {groups.map(g => (
        <div key={g.title}>
          <div className="nav-group-title">{g.title}</div>
          {g.items.map(it => {
            const active = it.href === '/admin' ? path === '/admin' : path.startsWith(it.href)
            return (
              <Link key={it.href} href={it.href} className={`nav-item ${active ? 'active' : ''}`}>
                {it.icon}
                <span>{it.label}</span>
                {it.badge && it.badge !== '0' && <span className="nav-badge">{it.badge}</span>}
              </Link>
            )
          })}
        </div>
      ))}

      <div style={{ marginTop: 'auto', paddingTop: 20, borderTop: '1px solid var(--stone-lt)' }}>
        <div className="nav-item" style={{ fontSize: 12, color: 'var(--midgray)' }}>
          <IconInfo />
          <span>v0.1.0 · scaffold</span>
        </div>
      </div>
    </aside>
  )
}

/* ── Inline SVG icons (outline stroke, matches Salt icon language) ── */
const iconProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
function IconGrid()    { return <svg {...iconProps}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function IconReceipt() { return <svg {...iconProps}><path d="M5 3v18l3-2 3 2 3-2 3 2V3"/><path d="M8 7h9M8 11h9M8 15h6"/></svg> }
function IconFile()    { return <svg {...iconProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg> }
function IconUsers()   { return <svg {...iconProps}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg> }
function IconLayers()  { return <svg {...iconProps}><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg> }
function IconAlert()   { return <svg {...iconProps}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> }
function IconShield()  { return <svg {...iconProps}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg> }
function IconInfo()    { return <svg {...iconProps} style={{ width: 14, height: 14 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> }
