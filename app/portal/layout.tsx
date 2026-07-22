'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { browserClient } from '@/lib/supabase-browser'

function isOnboardingPath(path: string) {
  return path.startsWith('/portal/onboarding')
}

type NavItem = { href: string; label: string; icon: JSX.Element }
type NavGroup = { title: string; items: NavItem[] }

const authGroups: NavGroup[] = [
  {
    title: 'My account',
    items: [
      { href: '/portal/dashboard', label: 'Dashboard',  icon: <IcoGrid /> },
      { href: '/portal/upload',    label: 'Upload receipts', icon: <IcoUpload /> },
      { href: '/portal/invoices',  label: 'My invoices', icon: <IcoFile /> },
    ]
  },
  {
    title: 'Help',
    items: [
      { href: '/portal/faq',     label: 'FAQ',     icon: <IcoHelp /> },
      { href: '/portal/support', label: 'Support',  icon: <IcoMsg /> },
    ]
  }
]

const publicGroups: NavGroup[] = [
  {
    title: 'Portal',
    items: [
      { href: '/portal/login', label: 'Sign in', icon: <IcoGrid /> },
      { href: '/portal/faq',   label: 'FAQ',     icon: <IcoHelp /> },
    ]
  }
]

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const [name, setName] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const close = useCallback(() => setSidebarOpen(false), [])

  const isPreAuth = path === '/portal/login' || isOnboardingPath(path)

  useEffect(() => {
    if (isPreAuth) return
    let cancelled = false
    ;(async () => {
      const sb = browserClient()
      const { data: userRes } = await sb.auth.getUser()
      if (!userRes.user) return
      const meta = userRes.user.user_metadata as { first_name?: string }
      if (meta?.first_name && !cancelled) { setName(meta.first_name); return }
      const { data: bam } = await sb.from('bams').select('first_name').eq('auth_user_id', userRes.user.id).single()
      if (!cancelled && bam?.first_name) setName(bam.first_name)
    })()
    return () => { cancelled = true }
  }, [path, isPreAuth])

  if (isOnboardingPath(path)) return <>{children}</>

  const groups = isPreAuth ? publicGroups : authGroups

  async function logout() {
    const sb = browserClient()
    await sb.auth.signOut()
    window.location.href = '/portal/login'
  }

  return (
    <div className="portal-shell">
      <div className={`sidebar-backdrop${sidebarOpen ? ' open' : ''}`} onClick={close} />
      <aside className={`sidebar portal-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-brand" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, paddingBottom: 16 }}>
          <img src="/brand/download-removebg-preview.png" alt="Bud Light U" style={{ height: 52, width: 'auto' }} />
          <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2, color: 'rgba(255,255,255,0.4)' }}>
            BAM Portal
          </div>
        </div>

        {groups.map(g => (
          <div key={g.title}>
            <div className="nav-group-title">{g.title}</div>
            {g.items.map(it => {
              const active = it.href === '/portal/dashboard'
                ? path === '/portal/dashboard'
                : path.startsWith(it.href)
              return (
                <Link key={it.href} href={it.href} className={`nav-item ${active ? 'active' : ''}`} onClick={close}>
                  {it.icon}
                  <span>{it.label}</span>
                </Link>
              )
            })}
          </div>
        ))}

        <div style={{ marginTop: 'auto', paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {!isPreAuth && name && (
            <div style={{ padding: '6px 12px', fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>
              {name}
            </div>
          )}
          {!isPreAuth && (
            <button className="nav-item" onClick={logout} style={{ width: '100%', background: 'transparent', color: 'rgba(255,255,255,0.4)', border: 'none', cursor: 'pointer', fontSize: 13 }}>
              <IcoLogout />
              <span>Log out</span>
            </button>
          )}
        </div>
      </aside>

      <div style={{ minWidth: 0 }}>
        <div className="portal-mobile-header">
          <button className="admin-hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="admin-mobile-brand">
            <img src="/brand/download-removebg-preview.png" alt="Bud Light U" style={{ height: 28 }} />
            <span>Portal</span>
          </div>
        </div>
        <div className="portal-main">{children}</div>
      </div>
    </div>
  )
}

/* ── Inline SVG icons ── */
const ip = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.75 }
function IcoGrid()   { return <svg {...ip}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function IcoUpload() { return <svg {...ip}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> }
function IcoFile()   { return <svg {...ip}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg> }
function IcoHelp()   { return <svg {...ip}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> }
function IcoMsg()    { return <svg {...ip}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> }
function IcoLogout() { return <svg {...ip} style={{ width: 17, height: 17 }}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> }
