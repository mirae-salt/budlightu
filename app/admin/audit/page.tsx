export default function AuditLog() {
  return (
    <main className="container">
      <p className="eyebrow">SUPER ADMIN · AUDIT</p>
      <h1>Audit log</h1>
      <p className="subtle">Every write action on money- or PII-adjacent tables. Read-only.</p>

      <p className="muted" style={{ marginTop: 16 }}>
        Placeholder — filterable table of audit_log rows (entity / actor / action / diff).
      </p>
    </main>
  )
}
