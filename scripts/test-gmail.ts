import { createTransport } from 'nodemailer'
import { readFileSync } from 'fs'

const envFile = readFileSync('.env.local', 'utf8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].trim()
}

async function main() {
  const transport = createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER!,
      pass: process.env.GMAIL_APP_PASSWORD!,
    },
  })

  console.log(`Sending from: ${process.env.GMAIL_USER}`)
  const to = 'mirae.lee@ilovesalt.com'
  console.log(`Sending to: ${to}`)

  const info = await transport.sendMail({
    from: `Bud Light U <${process.env.GMAIL_USER}>`,
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
