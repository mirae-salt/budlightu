'use client'
import { useEffect, useState, useCallback, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { browserClient } from '@/lib/supabase-browser'
import { getRole, isAdminRole } from '@/lib/auth-claims'

/* ── Inline SVG icons (must be above const usage for HMR) ── */
const ip = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.75 }
function IcoGrid()   { return <svg {...ip}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function IcoUpload() { return <svg {...ip}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> }
function IcoFile()   { return <svg {...ip}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg> }
function IcoHelp()   { return <svg {...ip}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> }
function IcoMsg()    { return <svg {...ip}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> }
function IcoBook()   { return <svg {...ip}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> }
function IcoBank()   { return <svg {...ip}><path d="M3 10h18"/><path d="M12 3 3 8h18z"/><path d="M6 10v7M10 10v7M14 10v7M18 10v7"/><path d="M3 21h18"/></svg> }
function IcoLogout() { return <svg {...ip} style={{ width: 17, height: 17 }}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> }

function isOnboardingPath(path: string) {
  return path.startsWith('/portal/onboarding')
}

type NavItem = { href: string; label: string; icon: ReactNode }
type NavGroup = { title: string; items: NavItem[] }

function IcoHome() { return <svg {...ip}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><polyline points="9 21 9 14 15 14 15 21"/></svg> }

const authGroups: NavGroup[] = [
  {
    title: 'BAM Portal',
    items: [
      { href: '/portal/program', label: 'Home',  icon: <IcoHome /> },
      { href: '/portal/dashboard', label: 'Dashboard',  icon: <IcoGrid /> },
    ]
  },
  {
    title: 'My account',
    items: [
      { href: '/portal/upload',    label: 'Upload receipts', icon: <IcoUpload /> },
      { href: '/portal/invoices',  label: 'My invoices', icon: <IcoFile /> },
      { href: '/portal/account',   label: 'Banking details', icon: <IcoBank /> },
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
  const [profile, setProfile] = useState<{ name: string; initial: string } | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const close = useCallback(() => setSidebarOpen(false), [])

  const isLogin = path === '/portal/login'
  const [loggedIn, setLoggedIn] = useState(false)

  useEffect(() => {
    if (isLogin) return
    let cancelled = false
    ;(async () => {
      const sb = browserClient()
      const { data: userRes } = await sb.auth.getUser()
      if (!userRes.user) return
      if (!cancelled) setLoggedIn(true)
      // P0-A: the "Back to admin" link used to appear based on
      // `user_metadata.role`, which the student's own session can write. It is
      // only a nav link, but it now reads the trusted app_metadata claim so no
      // part of the app treats the client-writable bag as a role.
      if (!cancelled && isAdminRole(getRole(userRes.user))) setIsAdmin(true)
      let firstName = (userRes.user.user_metadata as { first_name?: string } | undefined)?.first_name
      if (!firstName) {
        const { data: bam } = await sb.from('bams').select('first_name, last_name').eq('auth_user_id', userRes.user.id).single()
        if (bam) firstName = bam.first_name
      }
      if (!cancelled && firstName) {
        setProfile({ name: firstName, initial: firstName.charAt(0).toUpperCase() })
      }
    })()
    return () => { cancelled = true }
  }, [path, isLogin])

  const isPreAuth = isLogin || (!loggedIn && path === '/portal/faq')
  const groups = isPreAuth ? publicGroups : authGroups

  async function logout() {
    const sb = browserClient()
    await sb.auth.signOut()
    window.location.href = '/portal/login'
  }

  return (
    <div className={`portal-shell${isPreAuth ? ' portal-shell--no-sidebar' : ''}`}>
      {!isPreAuth && (
        <>
          <div className={`sidebar-backdrop${sidebarOpen ? ' open' : ''}`} onClick={close} />
          <aside className={`sidebar portal-sidebar${sidebarOpen ? ' open' : ''}`}>
            <Link href="/portal/program" className="sidebar-brand" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '10px 10px 16px', textDecoration: 'none' }} onClick={(e) => { if (path === '/portal/program') { e.preventDefault(); window.location.reload() } close() }}>
              <img src="/brand/BudLightU-logo.png" alt="Bud Light U" style={{ width: '50%', maxWidth: 120, objectFit: 'contain' }} />
              <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2, color: 'rgba(255,255,255,0.4)' }}>
                BAM Portal
              </div>
            </Link>

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

            <div style={{ marginTop: 'auto', paddingTop: 16 }}>
              {isAdmin && (
                <div style={{ padding: '0 10px', marginBottom: 12 }}>
                  <Link href="/admin" onClick={close} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 12px', borderRadius: 8,
                    background: 'rgba(0,163,224,0.1)', border: '1px solid rgba(0,163,224,0.2)',
                    color: 'rgba(0,163,224,0.9)', fontSize: 13, fontWeight: 600,
                    textDecoration: 'none', transition: 'background 0.15s'
                  }}>
                    <svg {...ip} style={{ width: 16, height: 16 }}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/></svg>
                    <span>Switch to Admin</span>
                  </Link>
                </div>
              )}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '10px 10px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                {profile && (
                  <>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                      background: 'rgba(0,163,224,0.25)', color: '#3AADD9',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 700
                    }}>{profile.initial}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile.name}</div>
                    </div>
                  </>
                )}
                <button onClick={logout} title="Log out" style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'rgba(255,255,255,0.35)', padding: 4, display: 'flex', flexShrink: 0
                }}>
                  <IcoLogout />
                </button>
              </div>
            </div>
          </aside>
        </>
      )}

      <div style={{ minWidth: 0, width: isPreAuth ? '100%' : undefined }}>
        {!isPreAuth && (
          <div className="portal-mobile-header">
            <button className="admin-hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <Link href="/portal/program" className="admin-mobile-brand" style={{ textDecoration: 'none', color: 'inherit' }}>
              <img src="/brand/BudLightU-logo.png" alt="Bud Light U" style={{ height: 28 }} />
              <span>Portal</span>
            </Link>
          </div>
        )}
        <div className={isLogin ? '' : isPreAuth ? 'portal-main portal-main-centered' : 'portal-main'}>{children}</div>
      </div>
    </div>
  )
}

