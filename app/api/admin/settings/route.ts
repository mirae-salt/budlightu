/**
 * GET /api/admin/settings — where email actually goes right now.
 *
 * READ ONLY, and that is the point. Some of this routing lives in environment variables
 * (AP_EMAIL, AP_CC_EMAILS, EMAIL_FROM), which means changing it needs a Vercel edit and a
 * redeploy. Robin cannot do that, so until it moves into the database the least this can do
 * is show her what the values are, rather than leaving "who is copied on invoices to AP?"
 * as a question only Mirae can answer.
 *
 * The addresses are sanitized on the way out for the same reason they are on the way in: a
 * BOM or a trailing space in an env var is invisible and silently misroutes mail, and a
 * settings page that renders it as clean text hides exactly the thing worth seeing.
 */
import { NextResponse } from 'next/server'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { envAddress, envAddressListOr, addressProblem } from '../../../../lib/sanitize'

/** Same defaults as app/api/admin/send-ap and supabase/functions/sendApEmail. */
const AP_TO_FALLBACK = 'accounts.payable@ilovesalt.com'
const AP_CC_FALLBACK = 'robin.graham@ilovesalt.com,nb@ilovesalt.com'

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const apTo = envAddress('AP_EMAIL') ?? AP_TO_FALLBACK
  const apCc = envAddressListOr('AP_CC_EMAILS', AP_CC_FALLBACK)
  const from = envAddress('EMAIL_FROM') ?? null
  const replyTo = envAddress('REPLY_TO_EMAIL') ?? null

  // If an address is malformed we say so here instead of at 9am on the 16th when the AP
  // batch is going out.
  const problems = [
    ...(addressProblem('AP_EMAIL', apTo) ? [`AP_EMAIL: ${addressProblem('AP_EMAIL', apTo)}`] : []),
    ...apCc.flatMap((a, i) => {
      const p = addressProblem(`AP_CC_EMAILS[${i}]`, a)
      return p ? [p] : []
    })
  ]

  return NextResponse.json({
    ok: true,
    invoiceEmail: {
      to: apTo,
      cc: apCc,
      from,
      replyTo,
      /** True when these come from env, i.e. not editable in this app. */
      envControlled: true,
      problems
    }
  })
}
