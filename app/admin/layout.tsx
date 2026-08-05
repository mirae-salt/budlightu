'use client'
import { useState, useCallback } from 'react'
import { Sidebar } from './_components/Sidebar'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const close = useCallback(() => setSidebarOpen(false), [])

  return (
    <div className="admin-shell">
      <div className={`sidebar-backdrop${sidebarOpen ? ' open' : ''}`} onClick={close} />
      <Sidebar open={sidebarOpen} onNavigate={close} />
      <div style={{ minWidth: 0 }}>
        <div className="admin-mobile-header">
          <button className="admin-hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="admin-mobile-brand">
            <img src="/brand/BudLightU-logo.png" alt="Bud Light U" style={{ height: 28 }} />
            <span>U · Admin</span>
          </div>
        </div>
        <div className="admin-main">{children}</div>
      </div>
    </div>
  )
}
