// BLU Internal Guide — designed & built by Mirae Lee
'use client'

import { useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { RECEIPT_AUDIT_DAY, INVOICE_GENERATE_DAY } from '@/lib/cycle-schedule'

export default function GuidePage() {
  return (
    <>
      <TopBar crumbs={['System', 'BLU Internal Guide']} />

      <div className="surface" data-author="mirae">
        <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 4 }}>
          BLU Internal Guide
        </h2>
        <p className="muted" style={{ marginBottom: 24, fontSize: 13 }}>
          Setup, monthly flow, receipt rules, and what gets flagged.
        </p>

        <TabNav />
      </div>
    </>
  )
}

function TabNav() {
  const tabs = [
    { id: 'setup', label: 'Getting started' },
    { id: 'flow', label: 'How it works' },
    { id: 'bam-ux', label: 'What BAMs see' },
    { id: 'patterns', label: 'What counts as BL' },
    { id: 'flags', label: 'What gets flagged' },
    { id: 'emails', label: 'Emails & alerts' },
    { id: 'admin-actions', label: 'Admin actions' },
  ] as const
  const [active, setActive] = useState<string>('setup')

  return (
    <div>
      <style>{`
        :root { --built-by-mirae-lee: 1; }
        /* SCROLL, do not clip. This was overflow:visible, so once the tabs stopped fitting
           they spilled outside the bar with no way to reach them: measured 2026-08-14 at
           375px, four of seven tabs were unreachable, and removing a tab only moved where
           that starts. Scrolling the overflow keeps every tab reachable on a phone.
           NOTE: no backticks in this block, it lives inside a template literal.
           Wrapping was tried first and rejected: it costs a second row on desktop, because
           flex wraps the line before it shrinks the items. */
        .guide-tabs { display: flex; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch;
          border-bottom: 2px solid var(--border); margin-bottom: 24px; }
        /* Tabs keep the default shrink and the default text wrapping, so a wide window still
           fits all seven on one row with no scrollbar (measured: 876px of tabs in an 891px
           bar). Only when shrinking runs out, on a phone, does the bar start scrolling. */
        .guide-tab { padding: 8px 16px; font-size: 13px; font-weight: 600; color: var(--midgray);
          cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; background: none;
          border-top: none; border-left: none; border-right: none; }
        /* Tap target on a phone: 8px padding gives a 33px-tall control, under the 44px
           minimum. Only below the sidebar breakpoint, so the desktop bar keeps its density. */
        @media (max-width: 768px) {
          .guide-tab { padding: 11px 14px; }
        }
        .guide-tab:hover { color: var(--bl-navy); background: rgba(0,0,0,0.03); border-radius: 6px 6px 0 0; }
        .guide-tab.active { color: #fff; background: var(--bl-blue); border-bottom-color: var(--bl-blue); border-radius: 6px 6px 0 0; }
        .guide-tab.active:hover { color: var(--bl-navy); background: var(--bl-blue); }
        .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
        .pill-green { background: rgba(34,197,94,0.12); color: #16a34a; }
        .pill-yellow { background: rgba(245,158,11,0.12); color: #d97706; }
        .pill-red { background: rgba(239,68,68,0.1); color: #dc2626; }
        .pill-blue { background: rgba(0,180,224,0.1); color: #0284c7; }
        .pill-gray { background: rgba(128,128,128,0.1); color: #6b7280; }
        .pattern-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (max-width: 600px) { .pattern-grid { grid-template-columns: 1fr; } }
        .pattern-card { padding: 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
        .pattern-card h4 { font-size: 13px; font-weight: 700; margin: 0 0 6px 0; color: var(--bl-navy); }
        .pattern-card code { font-size: 11px; background: rgba(0,0,0,0.04); padding: 1px 4px; border-radius: 3px; font-family: monospace; }
        .step-box { margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
        .step-box:last-child { border-bottom: none; margin-bottom: 0; }
        .step-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .step-num { width: 28px; height: 28px; border-radius: 50%; background: var(--bl-blue); color: #fff;
          display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
        .step-title { font-size: 16px; font-weight: 700; color: var(--bl-navy); }
        .info-box { font-size: 13px; line-height: 1.6; padding: 8px 12px; border-radius: 6px; margin-top: 8px; }
        .info-auto { background: rgba(0,180,224,0.08); }
        .info-you { background: rgba(239,68,68,0.06); }
        .info-note { background: rgba(128,128,128,0.06); }
      `}</style>

      <div className="guide-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`guide-tab${active === t.id ? ' active' : ''}`} onClick={() => setActive(t.id)}>{t.label}</button>
        ))}
      </div>

      {active === 'setup' && <SetupPanel />}
      {active === 'flow' && <FlowPanel />}
      {active === 'bam-ux' && <BamUxPanel />}
      {active === 'patterns' && <PatternsPanel />}
      {active === 'flags' && <FlagsPanel />}
      {active === 'emails' && <EmailsPanel />}
      {active === 'admin-actions' && <AdminActionsPanel />}


      {/* b·m·l */}
      <div style={{ marginTop: 40, paddingTop: 16, borderTop: '1px solid var(--border)', textAlign: 'center' }}>
        <p style={{ fontSize: 11, color: 'rgba(128,128,128,0.4)', userSelect: 'none' }}>
          BLU Automation v0.1
        </p>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 0: Getting started — first-time setup for Robin/Jenna
   ═══════════════════════════════════════════════════════════════════ */
function SetupPanel() {
  return (
    <>
      <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 20, color: 'var(--text)' }}>
        This is a one-time setup you do at the start of each cohort (semester). Once it&apos;s done, the monthly flow runs on its own.
      </p>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">1</span>
          <span className="step-title">Create a cohort</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Go to the <strong>Cohorts</strong> page and create a new cohort for the semester (e.g. &quot;Fall 2026&quot;).
          Set the PO number, start/end dates, and leave the send mode on <strong>dryrun</strong> until you&apos;re ready to go live.
        </p>
        <div className="info-box info-note">
          <strong>Why cohorts?</strong> Each semester has its own group of BAMs, PO number, and settings.
          You can have multiple cohorts active at once (e.g. summer stragglers + fall new hires).
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">2</span>
          <span className="step-title">Import your BAM list</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Go to the <strong>Roster</strong> page and click <strong>Import roster</strong>.
          Upload the list of accepted applicants. The file only needs two things: <strong>name</strong> and <strong>email</strong>.
        </p>
        <div style={{ margin: '12px 0', padding: '12px 16px', background: 'rgba(0,0,0,0.03)', borderRadius: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--bl-navy)', marginBottom: 8 }}>What the system accepts:</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <div><span className="pill pill-green">OK</span> &nbsp;Full Name + Email (two columns)</div>
            <div><span className="pill pill-green">OK</span> &nbsp;First Name + Last Name + Email (three columns)</div>
            <div><span className="pill pill-green">OK</span> &nbsp;Name + Email + School (extra columns are optional)</div>
          </div>
        </div>
        <div className="info-box info-auto">
          <strong style={{ color: 'var(--bl-blue-ink)' }}>Automatic:</strong> The system maps your column headers automatically. If it guesses wrong, you can fix the mapping before importing.
        </div>
        <div className="info-box info-note" style={{ marginTop: 8 }}>
          <strong>Tip:</strong> You can also add BAMs one at a time with the <strong>Add BAM</strong> button.
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">3</span>
          <span className="step-title">Invite emails go out</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          When you import, each BAM gets an email with a one-time link to set up their account.
          They&apos;ll enter their personal info and banking details through an onboarding form.
        </p>
        <div className="info-box info-auto">
          <strong style={{ color: 'var(--bl-blue-ink)' }}>Automatic:</strong> Invite emails are sent immediately after import.
          Each link is unique and can only be used once.
        </div>
        <div className="info-box info-you" style={{ marginTop: 8 }}>
          <strong style={{ color: 'var(--red, #ef4444)' }}>Important:</strong> Tell BAMs to use the <strong>same email they applied with</strong>.
          That&apos;s the email tied to their account. If someone needs to change their email later, you can update it in the Roster page.
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">4</span>
          <span className="step-title">BAMs complete onboarding</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Each BAM clicks their invite link and fills out the onboarding form: name, address, banking details (bank name, transit number, account number, institution code).
          This info is used to generate their invoices automatically.
        </p>
        <div className="info-box info-note">
          <strong>You don&apos;t need to collect banking info yourself.</strong> BAMs enter it directly into the secure form.
          You can see who has completed onboarding on the <strong>Dashboard</strong> (pending vs active BAMs).
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">5</span>
          <span className="step-title">You&apos;re ready to go</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Once BAMs have completed onboarding, the monthly cycle can begin.
          Switch to the <strong>How it works</strong> tab to see the month-to-month process.
        </p>
        <div style={{ margin: '12px 0', padding: '12px 16px', background: 'rgba(0,115,207,0.06)', borderRadius: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--bl-navy)', marginBottom: 8 }}>Quick checklist before first month:</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <div>&#9744; Cohort created with correct PO number</div>
            <div>&#9744; BAMs imported and invite emails sent</div>
            <div>&#9744; BAMs have completed onboarding (check Dashboard)</div>
            <div>&#9744; Send mode set to <strong>dryrun</strong> for your first test run</div>
          </div>
        </div>
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 1: How it works — plain language walkthrough
   ═══════════════════════════════════════════════════════════════════ */
function FlowPanel() {
  return (
    <>
      <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 20, color: 'var(--text)' }}>
        Every month, this is what happens from start to finish. Most of it is automatic. You only need to step in at two points.
      </p>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">1</span>
          <span className="step-title">BAMs upload their receipts</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Each BAM logs into the portal, picks their month, and uploads photos of their Bud Light receipts.
          They can upload multiple receipts. Phone photos, screenshots, and scanned images all work.
        </p>
        <div className="info-box info-auto">
          <strong style={{ color: 'var(--bl-blue-ink)' }}>Automatic:</strong> The system saves the file and checks if the same image was already submitted before (prevents duplicates).
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">2</span>
          <span className="step-title">AI reads what&apos;s on the receipt</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          The system looks at each receipt image, reads the text, and finds any Bud Light products.
          It pulls out the store name, date, item names, prices, tax, and the Bud Light total.
        </p>
        <div className="info-box info-auto">
          <strong style={{ color: 'var(--bl-blue-ink)' }}>Automatic:</strong> Trained on 400+ real receipts from 40+ Canadian stores. It knows how different stores print &quot;Bud Light&quot; (see the <em>What counts as BL</em> tab).
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">3</span>
          <span className="step-title">Safety checks run</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          The system runs a series of automatic checks on every receipt to catch problems, like duplicate submissions, suspicious patterns, or images that aren&apos;t actually receipts. Details are in the <em>What gets flagged</em> tab.
        </p>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">4</span>
          <span className="step-title">You review anything that&apos;s unclear</span>
          <span className="badge badge-yellow">Your action</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Each receipt gets one of three statuses:
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' }}>
          <StatusRow color="#22c55e" label="Approved" desc="Everything looks good. No action needed from you." />
          <StatusRow color="#f59e0b" label="Needs review" desc="Something was unclear or flagged. You decide: approve it or reject it." />
          <StatusRow color="#ef4444" label="Couldn't read" desc="The image was too blurry or damaged. You can ask the BAM to resubmit." />
        </div>
        <div className="info-box info-you">
          <strong style={{ color: 'var(--red, #ef4444)' }}>Your action:</strong> Go to <strong>Receipts</strong> page, filter by &quot;Review&quot;, and approve or reject each one.
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">5</span>
          <span className="step-title">Reimbursement is calculated</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Each BAM gets up to <strong>$150/month</strong> for Bud Light purchases. This resets every month. Unused amounts do not carry over. If a BAM spends less than $150, they get reimbursed only what they spent.
        </p>
        <div className="info-box info-note">
          <strong>Example:</strong> A BAM who spent $120 in September gets $120 reimbursed.
          In October they start fresh with another $150 allowance.
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">6</span>
          <span className="step-title">Invoices auto-generate on the {INVOICE_GENERATE_DAY}th</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          On the <strong>{INVOICE_GENERATE_DAY}th of each month</strong>, invoices are automatically generated for every active BAM.
          The system pulls each BAM&apos;s info from the roster (name, bank details, salary, reimbursement amount) and creates all invoices at once.
        </p>
        <div className="info-box info-auto">
          <strong style={{ color: 'var(--bl-blue-ink)' }}>Automatic:</strong> Invoice numbers, bank codes, amounts, and PDFs are all generated without any action needed.
        </div>
        <div className="info-box info-note" style={{ marginTop: 8 }}>
          <strong>Manual preview:</strong> You can click <strong>PDF</strong> on any invoice to preview or download it at any time. This is just a preview and does not send anything.
        </div>
        <div className="info-box info-you" style={{ marginTop: 8 }}>
          <strong style={{ color: 'var(--red, #ef4444)' }}>Your action:</strong> Review the generated invoices, then select the ones you want to send and hit <strong>Approve selected</strong>.
          See the <em>Admin actions</em> tab for what each button does.
        </div>
      </div>

      <div className="step-box">
        <div className="step-header">
          <span className="step-num">7</span>
          <span className="step-title">Invoices are sent to AP</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          After you approve, each invoice PDF is emailed to Accounts Payable (one email per invoice). A copy goes to SharePoint for records, and the BAM gets a copy too.
        </p>
        <div className="info-box info-note">
          <strong>Note:</strong> Right now the system is in test mode. It won&apos;t actually send emails until you turn on live mode in settings.
        </div>
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 2b: What BAMs see — explaining BAM-side experience for Robin
   ═══════════════════════════════════════════════════════════════════ */
function BamUxPanel() {
  return (
    <>
      <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 20, color: 'var(--text)' }}>
        This is what your BAMs experience when they use the portal. You can share this with new BAMs or reference it when answering their questions.
      </p>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        Signing in
      </h3>
      <div className="step-box">
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          BAMs sign in with their <strong>email only</strong>. There is no password to create or remember.
        </p>
        <div style={{ margin: '12px 0', padding: '16px', background: 'rgba(0,115,207,0.04)', borderRadius: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--bl-navy)', marginBottom: 10 }}>How it works:</p>
          <ol style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
            <li>BAM enters their email on the login page</li>
            <li>They receive a <strong>6-digit code</strong> in their inbox</li>
            <li>They type the code into the portal</li>
            <li>They&apos;re in. That&apos;s it.</li>
          </ol>
        </div>
        <div className="info-box info-note">
          <strong>Why no password?</strong> BAMs will never DM you about a forgotten password.
          The code expires after 10 minutes, and each login sends a fresh one.
        </div>
        <div className="info-box info-you" style={{ marginTop: 8 }}>
          <strong style={{ color: 'var(--red, #ef4444)' }}>Common question:</strong> &quot;I didn&apos;t get the code.&quot;
          Have them check their spam/junk folder first. The email comes from <strong>noreply@budlightu.com</strong>. If they still can&apos;t find it, they can click &quot;Resend code&quot; on the login screen.
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        First time: onboarding
      </h3>
      <div className="step-box">
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          When a BAM clicks their invite link for the first time, they land on a <strong>secure onboarding form</strong>.
          They fill in their personal details and banking info (for direct deposit).
        </p>
        <div style={{ margin: '12px 0', padding: '16px', background: 'rgba(0,0,0,0.03)', borderRadius: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--bl-navy)', marginBottom: 10 }}>What they fill in:</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 13 }}>
            <div><span className="pill pill-blue">Step 1</span> Full name, phone, address</div>
            <div><span className="pill pill-blue">Step 2</span> Bank name, transit #, account #</div>
          </div>
        </div>
        <div className="info-box info-auto">
          <strong style={{ color: 'var(--bl-blue-ink)' }}>Automatic:</strong> Once they submit, their status changes from &quot;pending&quot; to &quot;active&quot; in your roster.
          You can see who hasn&apos;t completed onboarding on the Dashboard.
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        Monthly: uploading receipts
      </h3>
      <div className="step-box">
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          Each month, BAMs upload their Bud Light receipts through the <strong>Upload</strong> page.
        </p>
        <div style={{ margin: '12px 0', padding: '16px', background: 'rgba(0,0,0,0.03)', borderRadius: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--bl-navy)', marginBottom: 10 }}>What they do:</p>
          <ol style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
            <li>Pick the month (e.g. &quot;September 2026&quot;)</li>
            <li>Take a photo of their receipt or select from camera roll</li>
            <li>Upload one or more images</li>
            <li>The system confirms the upload and shows the AI-read results</li>
          </ol>
        </div>
        <div className="info-box info-note">
          <strong>What they see after upload:</strong> A summary card showing the store name, date,
          Bud Light items found, and the total. If something was flagged, they see
          &quot;Under review&quot; instead of &quot;Approved&quot;.
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        Their portal pages
      </h3>
      <div className="step-box" style={{ borderBottom: 'none' }}>
        <div className="table-scroll">
          <table className="admin-table" style={{ fontSize: 13 }}>
            <thead><tr><th>Page</th><th>What they see</th></tr></thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Dashboard</td>
                <td>This month&apos;s spending total, remaining allowance, and receipt submission status</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Upload</td>
                <td>Receipt upload form + history of past uploads with AI results</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Invoices</td>
                <td>List of their invoices (month, amount, status). They cannot edit these.</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>FAQ</td>
                <td>Common questions about the program, receipts, and payments</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Support</td>
                <td>If they can&apos;t submit receipts this month, they explain why here. The message goes to you.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="info-box info-note" style={{ marginTop: 12 }}>
          <strong>Privacy:</strong> Each BAM only sees their own data. They cannot see other BAMs&apos; receipts, invoices, or information.
        </div>
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 2: What counts as BL — 400+ receipts analyzed by Mirae
   ═══════════════════════════════════════════════════════════════════ */
function PatternsPanel() {
  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>
          Different stores print &quot;Bud Light&quot; in different ways. The system recognizes all of these based on <strong>400+ real receipts</strong> from the summer pilot.
        </p>
        <div className="info-box info-note">
          When new receipts come in with text we haven&apos;t seen before, we&apos;ll review them in batches and confirm with you before adding.
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        How stores print &quot;Bud Light&quot;
      </h3>

      <div className="pattern-grid">
        <PatternCard title="Full product names" items={[
          { text: 'BUD LIGHT', note: 'Most common' },
          { text: 'BUD LIGHT LIME', note: 'Flavour variant' },
          { text: 'BUD LIGHT DOUBLE LIME', note: 'Common' },
          { text: 'BUD LIGHT SELTZER', note: '+ flavours like mango, cherry' },
          { text: 'BUD LIGHT CHELADA', note: 'Clamato mix' },
          { text: 'BUD LIGHT APPLE', note: 'Flavour variant' },
          { text: 'BUD LIGHT STRAWBERRY LEMONADE', note: 'Common' },
        ]} />

        <PatternCard title="Short forms & store codes" items={[
          { text: 'BUD LT', note: 'Couche-Tard, Beer Store' },
          { text: 'BL TALL CAN 6X', note: 'Beer Store uses "BL"' },
          { text: 'BUD DBL LIME', note: 'Calgary Co-op' },
          { text: 'LABATT - BUD LIGHT', note: 'BC Liquor' },
          { text: 'BUDLIGHT', note: 'No space, small stores' },
        ]} />

        <PatternCard title="French receipts (Quebec)" items={[
          { text: 'BUD LIGHT BIERE', note: 'Super C, "beer" in French' },
          { text: 'BUDLIG.BIERE CAN', note: 'Metro QC, shortened' },
          { text: 'BUDLISELT.EAU P.', note: 'Metro QC seltzer' },
        ]} />

        <PatternCard title="Misprints (faded/thermal)" items={[
          { text: 'BUD LIOT', note: 'LCBO printers sometimes garble letters' },
          { text: 'BJD LIGHT', note: 'U printed as J' },
          { text: 'BUD L1AT', note: 'I printed as 1' },
        ]} />

        <PatternCard title="Bar & restaurant receipts" items={[
          { text: 'DFT Bud Light', note: '"Draft" Bud Light' },
          { text: 'Can Bud Light', note: 'Arena/bar format' },
          { text: 'Bud Light (no code)', note: 'Just the name, no product code' },
        ]} />

        <PatternCard title="Pack sizes you might see" items={[
          { text: '24UC, 30UC, 60UC', note: 'Beer Store, unit count' },
          { text: '6TC, 12TC, 24TC', note: 'Beer Store, tall can' },
          { text: '6X355, 12X473', note: 'LCBO, count x volume in mL' },
          { text: '6 PK-C, 15 PK-C', note: 'LCBO, pack codes' },
        ]} />
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', margin: '24px 0 12px' }}>
        Stores we recognize (40+)
      </h3>
      <div className="table-scroll">
        <table className="admin-table" style={{ fontSize: 12 }}>
          <thead><tr><th>Province</th><th>Stores</th></tr></thead>
          <tbody>
            <StoreRow region="Ontario" stores="LCBO, Beer Store, Wine Rack, Loblaws, Superstore, Metro, Campus One Stop" />
            <StoreRow region="Quebec" stores="SAQ, Couche-Tard, Metro, Super C, Maxi, Proxi, various depanneurs" />
            <StoreRow region="Alberta" stores="Liquor Depot, ACE Liquor, Boss Liquor, Liquor House, Calgary Co-op, Safeway Liquor, Wine and Beyond" />
            <StoreRow region="BC" stores="BC Liquor, UBC Liquor, Angry Otter, Great Canadian Liquor" />
            <StoreRow region="SK" stores="Sherwood Co-op, Lake Country Co-op, Urban Cellars" />
            <StoreRow region="NS / NB" stores="NSLC, NB Liquor" />
            <StoreRow region="National" stores="Costco, Sobeys" />
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', margin: '24px 0 12px' }}>
        These are NOT Bud Light
      </h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        The system knows to skip these even if they appear on the same receipt:
      </p>
      <div style={{ fontSize: 13, lineHeight: 1.8 }}>
        <span className="pill pill-red">Budweiser</span>{' '}
        <span className="pill pill-red">Michelob</span>{' '}
        <span className="pill pill-red">White Claw</span>{' '}
        <span className="pill pill-red">Smirnoff</span>{' '}
        <span className="pill pill-red">Corona</span>{' '}
        <span className="pill pill-red">Coors Seltzer</span>{' '}
        <span className="pill pill-red">Cottage Springs</span>{' '}
        <span className="pill pill-red">Palm Bay</span>{' '}
        <span className="pill pill-red">Twisted Tea</span>{' '}
        <span className="pill pill-red">SVNS Hard 7UP</span>
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 3: What gets flagged — tuned by Mirae from 400-receipt analysis
   ═══════════════════════════════════════════════════════════════════ */
function FlagsPanel() {
  return (
    <>
      <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
        The system automatically checks every receipt before you see it. If anything looks off, it gets sent to your <strong>Review</strong> queue instead of being auto-approved.
      </p>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        What the system checks for
      </h3>

      <div className="table-scroll">
        <table className="admin-table" style={{ fontSize: 13 }}>
          <thead><tr><th>Check</th><th>What it means</th><th style={{ width: 80 }}>Priority</th></tr></thead>
          <tbody>
            <FlagRow name="Not a real receipt" desc="The image is something else (bus ticket, Uber ride, bank notification, pizza order, etc)." severity="High" />
            <FlagRow name="Duplicate submission" desc="This exact same receipt (same store, date, and total) was already submitted." severity="High" />
            <FlagRow name="Spending looks suspicious" desc="3+ receipts from this BAM are all very close to their balance limit, or they always shop at the exact same store." severity="High" />
            <FlagRow name="Over their balance" desc="The receipt total is more than the BAM has available to spend." severity="Medium" />
            <FlagRow name="Math doesn't add up" desc="The items + tax on the receipt don't match the total shown." severity="Medium" />
            <FlagRow name="Unusual pricing" desc="A Bud Light item is priced below $2 or above $70, which is outside the normal range." severity="Medium" />
            <FlagRow name="Tax rate looks wrong" desc="The tax percentage is outside what's normal for Canadian provinces (5–15%)." severity="Medium" />
            <FlagRow name="No store name visible" desc="The receipt doesn't show which store it's from." severity="Medium" />
            <FlagRow name="Might be a screenshot" desc="The image looks like a screenshot or edited image, not a photo taken with a camera." severity="Low" />
          </tbody>
        </table>
      </div>


    </>
  )
}



/* ═══════════════════════════════════════════════════════════════════
   TAB 6: Admin actions — what each button does + reversibility
   ═══════════════════════════════════════════════════════════════════ */
function AdminActionsPanel() {
  return (
    <>
      <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 20, color: 'var(--text)' }}>
        What each admin action does, whether it can be undone, and when to use it.
      </p>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        Invoice page buttons
      </h3>
      <div className="table-scroll" style={{ marginBottom: 24 }}>
        <table className="admin-table" style={{ fontSize: 13 }}>
          <thead>
            <tr><th>Button</th><th>What happens</th><th>Reversible?</th></tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>PDF</td>
              <td>Preview the invoice as a PDF in your browser. You can also download it. <strong>Nothing is saved or sent.</strong></td>
              <td><span className="pill pill-green">Safe</span> No side effects</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Send AP</td>
              <td>Sends the invoice PDF to accounts.payable@ilovesalt.com with CC to the program managers on the Settings page, and the BAM. Records the send in the database so it can&apos;t be sent twice.</td>
              <td><span className="pill pill-red">No</span> Email is already delivered. You can void the invoice, but AP has the email.</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Approve selected</td>
              <td>Marks selected draft invoices as approved, then sends each one to AP + archives to SharePoint + sends BAM copy. Same as clicking &quot;Send AP&quot; on each one.</td>
              <td><span className="pill pill-red">No</span> All emails go out immediately. Void individual invoices after if needed.</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>✕ (Void)</td>
              <td>Marks the invoice as voided. A cancellation email draft is auto-generated for you to review and send to AP manually.</td>
              <td><span className="pill pill-yellow">Partial</span> The invoice is flagged, but if AP already processed it, you need to contact them.</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>CSV</td>
              <td>Downloads the current invoice list as a spreadsheet. No database changes.</td>
              <td><span className="pill pill-green">Safe</span></td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Download ZIP</td>
              <td>Downloads all invoice PDFs as a single zip file. No database changes.</td>
              <td><span className="pill pill-green">Safe</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="info-box info-you" style={{ marginBottom: 24 }}>
        <strong style={{ color: 'var(--red, #ef4444)' }}>Before going live:</strong> Make sure the cohort&apos;s send mode is set to <strong>dryrun</strong> for your first test cycle.
        In dryrun mode, &quot;Send AP&quot; still works but sends a test email to your address, not the real AP inbox.
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        Pending BAMs (onboarding)
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
        <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 8 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 6 }}>Why is a BAM &quot;pending&quot;?</p>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            A BAM shows as pending when they have been invited but have not completed the onboarding form yet.
            Once they open their invite link and submit their personal info + banking details, they automatically become &quot;active&quot;.
          </p>
        </div>

        <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 8 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 6 }}>What can you do about it?</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, lineHeight: 1.6 }}>
            <div><span className="pill pill-blue">Option 1</span> Wait. They may just need more time. Check the Dashboard to see the count.</div>
            <div><span className="pill pill-blue">Option 2</span> Re-send the invite email from the Roster page (select the BAM, click re-invite).</div>
            <div><span className="pill pill-blue">Option 3</span> If they should no longer be in the program, change their status to &quot;archived&quot; in the Roster page edit view.</div>
          </div>
        </div>

        <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 8 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 6 }}>How does removal work?</p>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            There is no hard delete. Changing a BAM&apos;s status to <strong>archived</strong> removes them from the active count, stops invoice generation for them, and hides them from the default roster view.
            Their records are kept for audit purposes.
          </p>
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 12 }}>
        Monthly timeline
      </h3>
      <div className="table-scroll">
        <table className="admin-table" style={{ fontSize: 13 }}>
          <thead><tr><th>Day</th><th>What happens</th><th>Who</th></tr></thead>
          <tbody>
            <tr>
              <td style={{ fontWeight: 700 }}>1st - 14th</td>
              <td>BAMs upload receipts for the current month</td>
              <td><span className="pill pill-gray">BAMs</span></td>
            </tr>
            <tr>
              <td style={{ fontWeight: 700 }}>15th</td>
              <td>Receipt deadline. You review anything in the review queue.</td>
              <td><span className="pill pill-yellow">You</span></td>
            </tr>
            <tr>
              <td style={{ fontWeight: 700 }}>{RECEIPT_AUDIT_DAY}th</td>
              <td>Receipt audit runs. Review anything it flags before invoices are generated.</td>
              <td><span className="pill pill-yellow">You</span></td>
            </tr>
            <tr>
              <td style={{ fontWeight: 700 }}>{INVOICE_GENERATE_DAY}th</td>
              <td><strong>Invoices auto-generate.</strong> Review the batch, then approve and send.</td>
              <td><span className="pill pill-yellow">You</span></td>
            </tr>
            <tr>
              <td style={{ fontWeight: 700 }}>{INVOICE_GENERATE_DAY}th+</td>
              <td>AP receives invoices, processes payment (net 15, direct deposit).</td>
              <td><span className="pill pill-gray">AP</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   Shared components
   ═══════════════════════════════════════════════════════════════════ */

function StatusRow({ color, label, desc }: { color: string; label: string; desc: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <strong>{label}</strong>
      <span className="muted">{desc}</span>
    </div>
  )
}

function FlagRow({ name, desc, severity }: { name: string; desc: string; severity: string }) {
  return (
    <tr>
      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{name}</td>
      <td>{desc}</td>
      <td>
        <span className={`pill ${severity === 'High' ? 'pill-red' : severity === 'Medium' ? 'pill-yellow' : 'pill-gray'}`}>
          {severity}
        </span>
      </td>
    </tr>
  )
}

function PatternCard({ title, items }: { title: string; items: { text: string; note: string }[] }) {
  return (
    <div className="pattern-card">
      <h4>{title}</h4>
      {items.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', fontSize: 12 }}>
          <code>{item.text}</code>
          <span className="muted" style={{ fontSize: 11 }}>{item.note}</span>
        </div>
      ))}
    </div>
  )
}

function ToggleScreenshot({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 12, fontWeight: 600, color: 'var(--bl-blue-ink)', display: 'flex', alignItems: 'center', gap: 4
        }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>&#9654;</span>
        {open ? 'Hide screenshot' : 'Show screenshot'}
      </button>
      {open && (
        <img
          src={src} alt={alt}
          style={{ marginTop: 8, borderRadius: 8, border: '1px solid var(--border)', width: '100%', maxWidth: 640 }}
        />
      )}
    </div>
  )
}

function StoreRow({ region, stores }: { region: string; stores: string }) {
  return (
    <tr>
      <td style={{ fontWeight: 700, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{region}</td>
      <td style={{ lineHeight: 1.7 }}>{stores}</td>
    </tr>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 5: Emails & alerts — what gets sent, to whom, when
   ═══════════════════════════════════════════════════════════════════ */
function EmailsPanel() {
  const emails: { trigger: string; to: string; cc?: string; subject: string; auto: boolean; note?: string }[] = [
    { trigger: 'Receipt rejected by admin', to: 'BAM', subject: 'Receipt not accepted for [month]', auto: true, note: 'Includes the rejection reason so the BAM knows why.' },
    { trigger: 'Receipt approved but below $140 (shortfall)', to: 'BAM', subject: 'Receipt shortfall notice for [month]', auto: true, note: 'Encourages uploading additional receipts before deadline.' },
    { trigger: 'Admin clicks "Flag & notify" on dashboard', to: 'Program manager', cc: 'Backup admin', subject: 'Low-spend alert: [BAM] — [month]', auto: false, note: 'Warning #2+ triggers reevaluation notice.' },
    { trigger: 'Admin sends warning to BAM (from dashboard)', to: 'BAM', cc: 'Program manager', subject: 'Spending reminder for [month]', auto: false, note: 'Friendly nudge about using the full $150 allowance.' },
    { trigger: 'BAM submits a support question', to: 'Program manager', subject: 'BLU Portal: support question from [BAM]', auto: true, note: 'YOU control how often: every question, once a day, or not at all. Set it on the Questions page.' },
    { trigger: 'Invoice sent to AP', to: 'AP', cc: 'Program managers, BAM', subject: 'Invoice [INV-XX#] for [BAM]', auto: false, note: 'Triggered by admin batch-approve. 1 PDF per email.' },
    { trigger: 'BAM requests invoice copy', to: 'BAM', subject: 'Your BLU invoice copy', auto: true, note: 'Self-service from portal. Only works after email is verified.' },
    { trigger: 'BAM invited to cohort', to: 'BAM', subject: 'Welcome to Bud Light U', auto: false, note: 'Contains one-time onboarding link. Triggered by admin import.' },
  ]

  return (
    <>
      <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 20, color: 'var(--text)' }}>
        Every email the system can send, who receives it, and what triggers it.
      </p>

      {/* Written here because a setting nobody knows about is the same as no setting.
          The point is that Robin can change this without asking anyone. */}
      <div className="info-box info-auto" style={{ marginBottom: 20 }}>
        <strong>You can change these yourself</strong>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <strong>Support question emails.</strong> On the <strong>Questions</strong> page,
            pick every question, once a day, or none. Questions are always saved on that
            page whatever you choose, so nothing is lost by turning the emails down.
          </li>
          <li>
            <strong>Maintenance notice.</strong> On the <strong>Maintenance</strong> page,
            show BAMs a banner or close the portal. Takes effect immediately, and an
            open tab picks it up within a minute.
          </li>
        </ul>
      </div>

      <div className="table-scroll" style={{ marginBottom: 24 }}>
        <table className="admin-table" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>Trigger</th>
              <th>To</th>
              <th>CC</th>
              <th>Subject</th>
              <th>Auto?</th>
            </tr>
          </thead>
          <tbody>
            {emails.map((e, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600, maxWidth: 240 }}>{e.trigger}</td>
                <td>{e.to}</td>
                <td className="muted">{e.cc ?? '—'}</td>
                <td><code style={{ fontSize: 11 }}>{e.subject}</code></td>
                <td>
                  {e.auto
                    ? <span className="pill pill-blue">Automatic</span>
                    : <span className="pill pill-yellow">Admin action</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="info-box info-auto" style={{ marginBottom: 16 }}>
        <strong>Automatic</strong> = fires on its own when the condition is met (no button click needed).
        <br />
        <strong>Admin action</strong> = you click a button to trigger it.
      </div>

      <div className="info-box info-you">
        <strong>Email provider:</strong> All emails are sent from <strong>noreply@budlightu.com</strong> via Resend.
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--bl-navy)', margin: '24px 0 12px' }}>
        Email deliverability (IMPORTANT)
      </h3>
      <div style={{ padding: '16px', border: '2px solid #dc2626', borderRadius: 8, marginBottom: 16, background: 'rgba(239,68,68,0.04)' }}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>
          Salt employees must add budlightu.com to Safe Senders
        </p>
        <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
          Microsoft 365 (Salt&apos;s email system) may block emails from <strong>budlightu.com</strong> because it is a new sending domain.
          Blocked emails go to <strong>quarantine</strong> (not junk) and never appear in your inbox.
          Each person who needs to receive BLU emails must add the domain to their safe senders list. This is a one-time setup.
        </p>
        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 8 }}>Who needs to do this:</p>
        <div className="table-scroll">
          <table className="admin-table" style={{ fontSize: 13 }}>
            <thead><tr><th>Who</th><th>Email</th><th>Why they receive BLU emails</th></tr></thead>
            <tbody>
              {/*
                Named people used to be listed here. That list went stale the moment
                somebody left, and the addresses are editable on the Settings page now,
                so a hardcoded copy is a second source that quietly disagrees with the
                one actually used. It points at the live values instead.
              */}
              <tr>
                <td style={{ fontWeight: 600 }}>Program managers on the CC list</td>
                <td>Settings &rsaquo; Invoice email</td>
                <td>CC on every AP invoice, low-spend alerts, support questions</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Accounts Payable</td>
                <td>accounts.payable@ilovesalt.com</td>
                <td>Receives all invoice PDFs (primary recipient)</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Mirae Lee</td>
                <td>mirae.lee@ilovesalt.com</td>
                <td>System admin, test emails</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ padding: '16px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 8 }}>
          How to add Safe Senders in Outlook
        </p>
        <ol style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
          <li>Open <strong>Outlook</strong> (web or desktop)</li>
          <li>Go to <strong>Settings</strong> (gear icon, top right)</li>
          <li>Click <strong>Mail</strong>, then <strong>Junk email</strong></li>
          <li>Under <strong>Safe senders and domains</strong>, click <strong>+ Add</strong></li>
          <li>Add both: <strong>noreply@budlightu.com</strong> and <strong>onboarding@budlightu.com</strong></li>
          <li>Click <strong>Save</strong></li>
        </ol>
        <ToggleScreenshot src="/guide/outlook-safe-senders.png" alt="Outlook Safe Senders settings showing noreply@budlightu.com and onboarding@budlightu.com added" />
      </div>

      <div className="info-box info-note">
        <strong>BAM students don&apos;t need to do this.</strong> BAMs use personal email (Gmail, school email, etc.) which handles new domains normally.
        This is only an issue with Salt&apos;s corporate Microsoft 365 security settings.
      </div>
    </>
  )
}
