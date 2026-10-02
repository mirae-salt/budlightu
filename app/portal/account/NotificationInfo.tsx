/**
 * The "what you'll hear from us" block on the account page.
 *
 * Was ReminderToggle.tsx: a student could turn the pre-deadline reminder off for
 * themselves. Removed 2026-08-14 per Robin, from the BL Campus x AI Final Connect
 * meeting: "I don't want them to be able to turn their reminders off." So there is
 * nothing left to set here, only to explain -- see lib/student-reminders.ts for
 * where the actual switch lives now (the admin `mode` setting, program-wide).
 *
 * Static, no fetch, no state. Renders unconditionally: unlike the toggle it
 * replaced, there is no roster row to be missing and no request that can fail.
 */
export function NotificationInfo() {
  return (
    <details className="account-notification-details">
      <summary>When will I get notifications?</summary>
      <p className="subtle" style={{ fontSize: 13, margin: '12px 0', lineHeight: 1.6 }}>
        Check the bell for receipt and invoice updates.
      </p>

      <ul style={{
        listStyle: 'none', padding: 0, margin: '0 0 14px',
        fontSize: 13, lineHeight: 1.7, color: 'var(--midgray)'
      }}>
        {[
          ['Receipt accepted', 'in the portal'],
          ['Receipt not accepted', 'in the portal and by email'],
          ['Invoice sent for payment', 'in the portal'],
          ['Spending under the monthly minimum', 'in the portal and by email'],
          ['An answer to a question you asked', 'in the portal and by email'],
          ['A reminder before the receipt deadline, if you have not submitted anything that month', 'by email'],
        ].map(([what, where]) => (
          <li key={what} style={{ display: 'flex', gap: 8 }}>
            <span aria-hidden style={{ color: 'var(--bl-blue, #0073cf)' }}>&middot;</span>
            <span><strong style={{ color: 'var(--bl-navy)', fontWeight: 600 }}>{what}</strong>, {where}</span>
          </li>
        ))}
      </ul>

    </details>
  )
}
