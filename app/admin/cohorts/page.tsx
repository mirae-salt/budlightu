export default function Cohorts() {
  return (
    <main className="container">
      <p className="eyebrow">COHORTS</p>
      <h1>Program cohorts</h1>
      <p className="subtle">
        Each intake = one cohort. Cohort settings (PO number, program label, salary defaults, send mode) live here.
      </p>

      <p className="muted" style={{ marginTop: 16 }}>
        Placeholder — CRUD for cohorts with the send_mode / bam_copy_mode / first_cohort_all_review toggles gated behind super-admin.
      </p>
    </main>
  )
}
