/**
 * The program terms, at /portal/terms.
 *
 * The onboarding checkbox has always said "I agree to the Bud Light U program terms"
 * and stored the acceptance, while there was nothing anywhere in the app to read. This
 * is that page, and the onboarding checkboxes now link to it.
 *
 * PUBLIC on purpose (middleware.ts exempts it, like /portal/faq). A student has to be
 * able to read what they are agreeing to while filling in the onboarding form, which
 * happens before they have a session.
 *
 * The wording lives in lib/terms.ts, not here, so the version stamped on an acceptance
 * and the words accepted stay in one place. Robin owns the wording.
 */
import Link from 'next/link'
import { TERMS_SECTIONS, TERMS_VERSION, TERMS_HAS_DRAFT_SECTIONS } from '@/lib/terms'

export default function TermsPage() {
  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Program terms</span></div>
      </div>

      <h1>Bud Light U program terms</h1>

      <div style={{ maxWidth: 960 }}>
        <p className="subtle" style={{ marginTop: 8 }}>
          Version {TERMS_VERSION}. These are the terms you agree to when you set up your
          account. Your acceptance is recorded with the version above.
        </p>

        {TERMS_HAS_DRAFT_SECTIONS && (
          <div
            className="surface"
            style={{
              marginTop: 20,
              background: 'rgba(180,83,9,0.06)',
              border: '1px solid rgba(180,83,9,0.25)'
            }}
          >
            <p style={{ margin: 0, fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
              <strong>Not final.</strong> Some sections below are still being written and
              are marked as drafts. Anything marked draft is not a program rule yet.
            </p>
          </div>
        )}

        {TERMS_SECTIONS.map((section, i) => (
          <div className="surface" key={section.heading} style={i === 0 ? { marginTop: 20 } : undefined}>
            <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>{section.heading}</span>
              {section.draft && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: 'rgba(180,83,9,0.12)',
                    color: '#92400e'
                  }}
                >
                  Draft
                </span>
              )}
            </h3>
            {section.body.map((para, j) => (
              <p
                key={j}
                className="subtle"
                style={{ margin: j === section.body.length - 1 ? 0 : '0 0 10px' }}
              >
                {para}
              </p>
            ))}
          </div>
        ))}

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>Questions about any of this</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Ask on the <Link href="/portal/support">Support</Link> page, or check the{' '}
            <Link href="/portal/faq">FAQ</Link> first. A program manager reads every question.
          </p>
        </div>
      </div>
    </>
  )
}
