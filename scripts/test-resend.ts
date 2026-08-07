/**
 * Diagnostic: send one Resend email with an attachment.
 *
 * P1-26: the old inline .env parser skipped the first variable whenever the file
 * had a BOM, and skipped any name containing a digit. This is the script you run
 * when email is broken, so it pointed at the wrong thing. It now uses the shared
 * BOM-safe parser and prints what it actually loaded before doing anything.
 */
import { Resend } from 'resend'
import { loadEnvFile, printEnvReport } from '../lib/load-env-file'
import { envAddress } from '../lib/sanitize'

const report = loadEnvFile('.env.local')
printEnvReport(report, ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'])

const TEST_RECIPIENT = envAddress('TEST_RECIPIENT_EMAIL') ?? 'mirae.lee@ilovesalt.com'

async function main() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set. Nothing was sent.')
    process.exit(1)
  }
  if (apiKey !== apiKey.trim()) {
    console.error('RESEND_API_KEY has leading or trailing whitespace. Fix the stored value.')
    process.exit(1)
  }

  const resend = new Resend(apiKey)
  console.log(`Sending via Resend to ${TEST_RECIPIENT}...`)

  // Create a dummy PDF-like attachment
  const pdfContent = Buffer.from('%PDF-1.4 fake test invoice content for attachment test')

  const { data, error } = await resend.emails.send({
    from: `BLU Invoice System <${envAddress('RESEND_FROM_EMAIL') ?? 'onboarding@resend.dev'}>`,
    to: TEST_RECIPIENT,
    subject: '[TEST] Resend + PDF Attachment Test',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #001a3e;">Resend Attachment Test</h2>
        <p>This email has a dummy PDF attached, simulating an AP invoice send.</p>
        <p style="color: #6b7280; font-size: 13px;">Sent at: ${new Date().toISOString()}</p>
      </div>
    `,
    attachments: [
      {
        filename: 'Robin Graham - July 2026 - Invoice #1.pdf',
        content: pdfContent,
      }
    ],
  })

  if (error) {
    console.error('Failed:', error.message)
    process.exit(1)
  }
  console.log('Sent! ID:', data?.id)
}

main().catch(e => { console.error('Error:', e.message); process.exit(1) })
