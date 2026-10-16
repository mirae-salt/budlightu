'use client'

/**
 * Catches a crash inside any admin page so the sidebar stays and the person sees what to do.
 * Without this file a render error replaces the whole screen with Next's bare
 * "Application error" text (Robin hit that on the review queue, 2026-10-16).
 */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
      <h2 style={{ marginBottom: 8 }}>This screen hit a problem</h2>
      <p style={{ marginBottom: 16 }}>
        Nothing was saved or changed. Try again, and if it keeps happening tell Mirae which screen and which
        student you were opening.
      </p>
      <button type="button" onClick={reset}>Try again</button>
      {error.digest && <p style={{ marginTop: 16, fontSize: 12 }}>Reference: {error.digest}</p>}
    </div>
  )
}
