import { Sidebar } from './_components/Sidebar'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-shell">
      <Sidebar />
      <div className="admin-main">{children}</div>
    </div>
  )
}
