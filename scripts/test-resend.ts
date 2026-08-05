import { Resend } from 'resend'
import { readFileSync } from 'fs'

const envFile = readFileSync('.env.local', 'utf8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].trim()
}

async function main() {
  const resend = new Resend(process.env.RESEND_API_KEY!)
  console.log('Sending via Resend to mirae.lee@ilovesalt.com...')

  // Create a dummy PDF-like attachment
  const pdfContent = Buffer.from('%PDF-1.4 fake test invoice content for attachment test')

  const { data, error } = await resend.emails.send({
    from: 'BLU Invoice System <onboarding@resend.dev>',
    to: 'mirae.lee@ilovesalt.com',
    subject: '[TEST] Resend + PDF Attachment Test',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #001a3e;">Resend Attachment Test</h2>
        <p>This email has a dummy PDF attached — simulating an AP invoice send.</p>
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
