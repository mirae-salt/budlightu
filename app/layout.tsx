import type { Metadata } from 'next'
import { DevBar } from './_components/DevBar'
import './globals.css'

export const metadata: Metadata = {
  title: 'Bud Light U | BAM Portal',
  description: 'Bud Light U campus ambassador invoice portal',
  authors: [{ name: 'Mirae Lee' }],
  creator: 'Mirae Lee',
  icons: {
    icon: '/favicon.png',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'Bud Light U | BAM Portal',
    description: 'Campus ambassador portal for receipts, invoices, and reimbursement',
    images: [{ url: '/og-image.png', width: 1200, height: 630 }],
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Mirae Lee, BLU-MRL-20260720 */}
      <body>
        <DevBar />
        {children}
      </body>
    </html>
  )
}
