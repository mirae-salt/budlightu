/**
 * Diagnostic: send one email through Gmail SMTP.
 *
 * P1-26: same BOM/digit bug as test-resend.ts. See lib/load-env-file.ts.
 * GMAIL_USER is read through `envAddress` so an invisible character in the
 * address fails loudly here instead of producing a mysterious SMTP rejection.
 */
import { createTransport } from 'nodemailer'
import { loadEnvFile, printEnvReport } from '../lib/load-env-file'
import { envAddress } from '../lib/sanitize'

const report = loadEnvFile('.env.local')
printEnvReport(report, ['GMAIL_USER', 'GMAIL_APP_PASSWORD'])

async function main() {
  const gmailUser = envAddress('GMAIL_USER')
  const gmailPass = process.env.GMAIL_APP_PASSWORD

  if (!gmailUser) {
    console.error(
      'GMAIL_USER is missing or is not a valid email address after sanitizing. ' +
      `Raw length: ${(process.env.GMAIL_USER ?? '').length}. Nothing was sent.`
    )
    process.exit(1)
  }
  if (!gmailPass) {
    console.error('GMAIL_APP_PASSWORD is not set. Nothing was sent.')
    process.exit(1)
  }
  if (gmailPass !== gmailPass.trim()) {
    console.error('GMAIL_APP_PASSWORD has leading or trailing whitespace. Fix the stored value.')
    process.exit(1)
  }

  const transport = createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass },
  })

  const to = envAddress('TEST_RECIPIENT_EMAIL') ?? 'mirae.lee@ilovesalt.com'
  console.log(`Sending from: ${gmailUser}`)
  console.log(`Sending to: ${to}`)

  const info = await transport.sendMail({
    from: `Bud Light U <${gmailUser}>`,
    to,
    subject: '[TEST] BLU Portal - Gmail SMTP Test',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #001a3e;">Gmail SMTP Test</h2>
        <p>If you're reading this, Gmail SMTP is working correctly for the BLU Portal.</p>
        <p style="color: #6b7280; font-size: 13px;">Sent at: ${new Date().toISOString()}</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;" />
        <p style="font-size: 11px; color: #9ca3af;">Bud Light U · Campus Ambassador Program</p>
      </div>
    `,
  })

  console.log('Email sent successfully!')
  console.log('Message ID:', info.messageId)
}

main().catch(e => {
  console.error('Failed:', e.message)
  process.exit(1)
})
