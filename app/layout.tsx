import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Bud Light U — BAM Portal',
  description: 'Bud Light U campus ambassador invoice portal'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
