/**
 * Admin sidebar — sectioned nav with icons.
 * Mirrors the reference layout structure with Salt XC palette.
 */
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { browserClient } from '@/lib/supabase-browser'

type NavItem = { href: string; label: string; icon: ReactNode; badge?: string }
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
      { href: '/admin/team',      label: 'Admin Team', icon: <IconKey /> },
      { href: '/admin/audit',     label: 'Audit log',  icon: <IconShield /> },
      { href: '/admin/guide',     label: 'BLU Guide', icon: <IconInfo /> }
    ]
  }
]

export function Sidebar({ open, onNavigate }: { open?: boolean; onNavigate?: () => void }) {
  const path = usePathname()
  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="sidebar-brand" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '10px 10px 16px' }}>
        <img src="/brand/BudLightU-logo.png" alt="Bud Light U" style={{ width: '50%', maxWidth: 120, objectFit: 'contain' }} />
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>Admin</span>
      </div>

      {groups.map(g => (
        <div key={g.title}>
          <div className="nav-group-title">{g.title}</div>
          {g.items.map(it => {
            const active = it.href === '/admin' ? path === '/admin' : path.startsWith(it.href)
            return (
              <Link key={it.href} href={it.href} className={`nav-item ${active ? 'active' : ''}`} onClick={onNavigate}>
                {it.icon}
                <span>{it.label}</span>
                {it.badge && it.badge !== '0' && <span className="nav-badge">{it.badge}</span>}
              </Link>
            )
          })}
        </div>
      ))}

      <div style={{ marginTop: 'auto', paddingTop: 16 }}>
        <div style={{ padding: '0 10px', marginBottom: 10 }}>
          <Link href="/portal/dashboard" onClick={onNavigate} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(0,163,224,0.1)', border: '1px solid rgba(0,163,224,0.2)',
            color: 'rgba(0,163,224,0.9)', fontSize: 13, fontWeight: 600,
            textDecoration: 'none', transition: 'background 0.15s'
          }}>
            <svg {...iconProps} style={{ width: 16, height: 16 }}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            <span>Switch to BAM Portal</span>
          </Link>
        </div>
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '10px 12px 4px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: 'var(--bl-blue)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, flexShrink: 0
          }}>M</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Mirae Lee</div>
          </div>
          <button onClick={async () => { const sb = browserClient(); await sb.auth.signOut(); window.location.href = '/portal/login' }} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.3)', padding: 4, display: 'flex'
          }} title="Log out">
            <svg {...iconProps} style={{ width: 15, height: 15 }}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
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
function IconKey()     { return <svg {...iconProps}><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> }
function IconShield()  { return <svg {...iconProps}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg> }
function IconInfo()    { return <svg {...iconProps} style={{ width: 14, height: 14 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> }
