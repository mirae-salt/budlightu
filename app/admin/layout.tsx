import Link from 'next/link'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav className="topbar">
        <span className="brand">BLU Admin</span>
        <Link href="/admin">Dashboard</Link>
        <Link href="/admin/receipts">Receipts</Link>
        <Link href="/admin/invoices">Invoices</Link>
        <Link href="/admin/roster">Roster</Link>
        <Link href="/admin/cohorts">Cohorts</Link>
        <Link href="/admin/unmatched">Unmatched</Link>
        <Link href="/admin/audit">Audit</Link>
      </nav>
      {children}
    </div>
  )
}
