# Bud Light U — invoice automation, handoff

**Built and maintained by Mirae Lee** (mirae.lee@ilovesalt.com) — sole developer.
Last updated 2026-08-18.

This is the operating manual: what the system does, how to run it, and what to touch
when something needs changing. It is deliberately short. It does not explain how each
design was arrived at, only what it currently is.

---

## 1. What it does

BAMs (campus ambassadors) are paid monthly by individual invoice. Before this, Robin
and Jenna did that by hand: check receipts, adjust invoices, save PDFs, email AP one at
a time, file them, update a tracker. About five hours a month, growing with headcount.

This replaces that with two screens and two decisions:

- **BAM portal** — students sign in, upload receipts, see their invoices, ask questions.
- **Admin dashboard** — Robin reviews flagged receipts, then approves invoices in a batch.

Everything else is automatic: reading receipts, computing reimbursement, numbering and
rendering invoices, emailing AP, storing the PDFs.

**Only two things need a human.** Both are Robin's:

1. **Receipt review** — receipts the AI could not decide on land in a queue.
2. **Batch approve** — invoices are generated as drafts; Robin approves and they send.

---

## 2. Where things live

| Thing | Where | Account |
|---|---|---|
| App (Next.js) | Vercel | Mirae's Vercel |
| Database, auth, file storage | Supabase | Shane's Supabase |
| Email delivery | Resend | Salt |
| Receipt reading (AI) | OpenRouter | Salt |
| Code | github.com/mirae-salt/budlightu (private) | Mirae |

Logins and domain details are in the shared credentials spreadsheet, not in this repo.

**Invoice PDFs are stored in the Supabase `invoices` bucket.** There is no SharePoint
copy. For an offline archive, use **Download ZIP** on `/admin/invoices` at the end of a
cohort. Worth agreeing a retention step with Robin: if the Supabase subscription lapses,
that bucket is the only copy.

---

## 3. Running it

```bash
npm install
npm run dev          # localhost:3000
```

`.env.local` is not in the repo. It needs: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`,
`SUPABASE_ACCESS_TOKEN`, `RESEND_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
`NEXT_PUBLIC_APP_URL`. Gmail and Microsoft Graph keys exist but are fallbacks.

Before pushing:

```bash
npm run typecheck && npm test && npm run build
```

Deploy is automatic on push to `main`. Confirm it actually shipped:

```bash
node scripts/probe/deployed-version.js
```

Database changes are SQL files in `supabase/migrations/`, applied with `npm run db:migrate`.

---

## 4. The monthly cycle

One Vercel cron hits `/api/cron` daily at **13:00 UTC**. It decides what to do from the
date. Day numbers are `AUDIT_DAY` and `GENERATE_DAY` in `app/api/cron/route.ts`.

| Day | What happens |
|---|---|
| 10th, 14th | Reminder email to BAMs who have submitted nothing yet. **Off by default.** |
| **15th** | Receipt deadline. After this the month is closed and uploads are refused. |
| **16th** | Receipts audited. Anything unclear goes to Robin's review queue. **Touchpoint 1.** |
| **17th** | Invoices generated as drafts. Robin batch-approves and they go to AP. **Touchpoint 2.** |
| every day | Digest email to Robin: pending bank changes, new questions. Sends only if something is waiting. |

The 16th and 17th are deliberately separate so there is a day to clear the review queue
before invoices are built. Do not collapse them: `/api/cron` is an `else if` chain, so
setting both to the same day means generate never runs.

**Invoices will not send while receipts are undecided.** That is intentional and it fails
closed. If a batch approve is refused, clear the review queue first.

---

## 5. What Robin can change without a developer

This matters: anything likely to change during operation was made editable so nobody has
to wait on code. It is all under `/admin`.

| Setting | Where |
|---|---|
| AP email address and CC list | Settings › Invoice email |
| How often she is emailed about questions | Settings |
| Student reminders: off / draft / live | Settings |
| Maintenance banner or portal block | `/admin/maintenance` |
| PO number, dates, send mode | Cohorts |
| Roster, cohort moves, CSV import | BAMs |

Anything stored in the `policy` table takes effect on save, with no redeploy.

**The BLU Guide (`/admin/guide`) is written for Robin, not for engineers.** Setup, the
monthly flow, what counts as a Bud Light item, what gets flagged, emails. Send her there
first.

---

## 6. Sending real email

Each cohort has a `send_mode`:

- `dryrun` — everything runs, nothing is emailed. **Current setting.**
- `live` — invoices actually go to AP.

**`send_mode = 'live'` is the one line that cannot be undone.** A sent email cannot be
recalled. `GO-LIVE.md` has the ordered checklist and the probes to run before and after.

To stop sends in a hurry, set the cohort back to `dryrun` on `/admin/cohorts`.

---

## 7. Check, do not guess

`scripts/probe/` holds read-only scripts that answer questions about the live system.
Full list in `scripts/probe/README.md`. The ones worth knowing:

```bash
node scripts/probe/can-sign-in.js          # can admins and students actually log in
node scripts/probe/schema-drift.js         # do the columns the code reads exist
node scripts/probe/ap-addresses.js         # where would an invoice go right now
node scripts/probe/invoice-copy-reach.js   # who would not receive their copy
node scripts/probe/deployed-version.js     # is what I pushed actually live
```

Probes run as service role, so they cannot verify RLS. For permission questions, log in
as a real account.

---

## 8. Open items

| Item | Owner | Notes |
|---|---|---|
| Terms and conditions wording | Mirae | Robin's financial-section edits applied 8/14. Any further edits go in `lib/terms.ts`, then bump `TERMS_VERSION`. |
| IT sender allowlist | Mirae | Ticket open since 8/12 so `noreply@budlightu.com` can reach AP. Until then invoices are CC'd to Guneet, who forwards. Shane escalates if IT stays silent. |
| Can AP accept a ZIP | Robin | AP's own automation expects one PDF per email. If they will take a batch, the allowlist problem largely goes away. |
| First-cycle shortfall exception | Robin | Onboarding to first deadline is only two weeks, so low spend may be common in month one. |
| Real-person testing | Robin | As of 8/17 only one receipt has ever been uploaded. Robin, Nathan and Janet should each upload one from a phone before 9/1 so touchpoint 1 gets exercised for real. |

---

## 9. If you are picking this up

Read in this order:

1. This file.
2. `/admin/guide` in the running app — it is the plain-language version.
3. `.claude/CLAUDE.md` — settled rules, parameters, constraints.
4. `GO-LIVE.md` — before anything is sent for real.
5. `ARCHITECTURE.md` — schema and component detail.

The code is commented with intent rather than mechanics: where something looks
roundabout, the comment usually says which failure it is avoiding. Read those before
simplifying.

Questions: mirae.lee@ilovesalt.com.
