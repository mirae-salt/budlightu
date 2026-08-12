/**
 * The once-a-day email: what is waiting on Robin.
 *
 * WHY IT EXISTS
 * -------------
 * Two separate gaps, one mechanism, because they are the same email in practice.
 *
 * 1. Support questions. /admin/questions lets Robin choose "once a day", and until now
 *    choosing it meant no email ever arrived: the option was offered without the job
 *    behind it, which is worse than not offering it.
 * 2. Banking change requests. A student submits one, a notification fires once, and if
 *    Robin misses that single moment the request sits. Nothing ever mentions it again.
 *    Meanwhile the invoice keeps going out to the OLD account, which is correct (the
 *    change is not approved) but not what anyone intends for long.
 *
 * IDEMPOTENCY WITHOUT A CURSOR
 * `portal_questions.notified_at` already exists. A question is included when it is
 * NULL, and stamped once the email is out. So a second run the same day sends nothing,
 * and a failed send leaves the rows unstamped to be picked up tomorrow. There is no
 * "last digest sent" timestamp to get out of step with reality.
 *
 * Banking requests are deliberately NOT stamped: they repeat every day until decided.
 * That is the point of a reminder, and `status` already says when to stop.
 */

export type DigestQuestion = {
  id: string
  question: string
  submitted_at: string
  bamName: string
  bamEmail: string | null
}

export type DigestBankingRequest = {
  id: string
  bamName: string
  requested_at: string
  reason: string
}

export type DigestInput = {
  questions: DigestQuestion[]
  pendingBanking: DigestBankingRequest[]
  appUrl: string
}

/** Nothing waiting means no email. An empty daily digest trains people to ignore it. */
export function hasAnythingToSend(input: DigestInput): boolean {
  return input.questions.length > 0 || input.pendingBanking.length > 0
}

function dayCount(iso: string, now: Date): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/** How long something has been waiting, in words an operator can act on. */
export function waitedFor(iso: string, now: Date): string {
  const days = dayCount(iso, now)
  if (days === 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

export function digestSubject(input: DigestInput): string {
  const q = input.questions.length
  const b = input.pendingBanking.length
  const parts: string[] = []
  if (q > 0) parts.push(`${q} question${q === 1 ? '' : 's'}`)
  if (b > 0) parts.push(`${b} banking change${b === 1 ? '' : 's'} to approve`)
  // The count goes in the subject so it can be triaged without opening it.
  return `Bud Light U: ${parts.join(' and ')} waiting`
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function digestHtml(input: DigestInput, now: Date = new Date()): string {
  const { questions, pendingBanking, appUrl } = input

  const bankingBlock = pendingBanking.length === 0 ? '' : `
    <p style="font-size:15px;color:#1a1a2e;font-weight:600;margin:24px 0 8px;">
      Banking changes waiting for you (${pendingBanking.length})
    </p>
    <p style="font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.5;">
      Until you approve one, invoices keep paying the account already on file. That is
      safe, but it is probably not what the BAM is expecting.
    </p>
    ${pendingBanking.map(r => `
      <div style="padding:10px 12px;border-left:3px solid #b45309;background:#fffbeb;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:600;color:#78350f;">
          ${esc(r.bamName)} <span style="font-weight:400;">waiting ${esc(waitedFor(r.requested_at, now))}</span>
        </div>
        <div style="font-size:13px;color:#374151;margin-top:2px;">${esc(r.reason)}</div>
      </div>`).join('')}
    <p style="margin:12px 0 0;">
      <a href="${appUrl}/admin/banking-requests" style="color:#0073cf;font-weight:600;font-size:13px;">
        Review banking changes
      </a>
    </p>`

  const questionBlock = questions.length === 0 ? '' : `
    <p style="font-size:15px;color:#1a1a2e;font-weight:600;margin:24px 0 8px;">
      New support questions (${questions.length})
    </p>
    ${questions.map(q => `
      <div style="padding:10px 12px;border-left:3px solid #0073cf;background:#f3f4f6;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:600;color:#1a1a2e;">
          ${esc(q.bamName)}${q.bamEmail ? ` &lt;${esc(q.bamEmail)}&gt;` : ''}
        </div>
        <div style="font-size:13px;color:#374151;margin-top:2px;white-space:pre-wrap;">${esc(q.question)}</div>
      </div>`).join('')}
    <p style="margin:12px 0 0;">
      <a href="${appUrl}/admin/questions" style="color:#0073cf;font-weight:600;font-size:13px;">
        Open the Questions page
      </a>
    </p>`

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:28px 24px;">
    <p style="font-size:16px;color:#1a1a2e;font-weight:600;margin:0;">What is waiting on you</p>
    <p style="font-size:13px;color:#6b7280;margin:4px 0 0;">
      One email a day. You can change how often on the Questions page.
    </p>
    ${bankingBlock}
    ${questionBlock}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 12px;" />
    <p style="font-size:11px;color:#9ca3af;">Bud Light U Automation</p>
  </div>`
}

export function digestText(input: DigestInput, now: Date = new Date()): string {
  const lines: string[] = ['What is waiting on you', '']

  if (input.pendingBanking.length > 0) {
    lines.push(`Banking changes waiting for you (${input.pendingBanking.length})`)
    lines.push('Until you approve one, invoices keep paying the account already on file.')
    for (const r of input.pendingBanking) {
      lines.push(`  - ${r.bamName}, waiting ${waitedFor(r.requested_at, now)}: ${r.reason}`)
    }
    lines.push(`  ${input.appUrl}/admin/banking-requests`, '')
  }

  if (input.questions.length > 0) {
    lines.push(`New support questions (${input.questions.length})`)
    for (const q of input.questions) {
      lines.push(`  - ${q.bamName}${q.bamEmail ? ` <${q.bamEmail}>` : ''}: ${q.question}`)
    }
    lines.push(`  ${input.appUrl}/admin/questions`, '')
  }

  lines.push('One email a day. You can change how often on the Questions page.')
  lines.push('- Bud Light U Automation')
  return lines.join('\n')
}
