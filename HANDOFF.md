# Bud Light U — invoice automation, handoff

**Built and maintained by Mirae Lee** (mirae.lee@ilovesalt.com) — sole developer.

Operations manual. What the system does, how to run it, what is safe to touch. It does not cover why it was designed this way.

---

## 1. What it does

Campus ambassadors (BAMs) are paid monthly with an individual invoice each. There are two screens.

- **BAM portal** — students log in, upload receipts, view invoices, and ask questions.
- **Admin dashboard** — Robin reviews flagged receipts and bulk-approves invoices.

Receipt reading, reimbursement math, invoice numbering and rendering, the AP email, and PDF storage all run automatically. There are two human touchpoints, both Robin: receipt review (whatever the AI could not decide) and bulk approval (approving the draft-generated invoices sends them).

---

## 2. Where things live

| Thing | Where | Account |
|---|---|---|
| App (Next.js) | Vercel | Mirae's Vercel |
| DB · auth · storage | Supabase | Shane's Supabase |
| Email | Resend | Salt |
| Receipt reading (AI) | OpenRouter | Salt |
| Code | github.com/mirae-salt/budlightu (private) | Mirae |

Login and domain details are in the shared credentials spreadsheet, not in this repo. Invoice PDFs are stored in the Supabase `invoices` bucket.

---

## 3. Running it

```bash
npm install
npm run dev          # localhost:3000
```

`.env.local` is not in the repo. Required keys: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`,
`SUPABASE_ACCESS_TOKEN`, `RESEND_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
`NEXT_PUBLIC_APP_URL`.

Before pushing:

```bash
npm run typecheck && npm test && npm run build
```

Pushing to `main` deploys automatically. Apply DB changes by running the SQL in `supabase/migrations/` with `npm run db:migrate`.

---

## 4. The monthly cycle

A Vercel cron hits `/api/cron` daily at 13:00 UTC. The date decides what runs.

| Day | What happens |
|---|---|
| 15th | Receipt deadline. Uploads rejected after this |
| 16th | Receipt audit. Unclear ones go to Robin's review queue (touchpoint 1) |
| 17th | Invoice drafts generated. Robin bulk-approves → AP (touchpoint 2) |
| daily | Digest email to Robin when anything is pending |

If a receipt is unresolved, the invoice does not go out (fail closed). The 16th and 17th are never collapsed into one day.

---

## 5. What Robin can change (no developer)

Changed under `/admin`: AP email and CC, question-notification frequency, student reminders (off/draft/live), maintenance banner, PO / dates / send mode (Cohorts), roster and CSV import. Values in the `policy` table take effect as soon as they are saved. Robin's guide is at `/admin/guide` in the running app.

---

## 6. Sending real email

Each cohort has a `send_mode`: `dryrun` (current, nothing sent) or `live` (actually sent). `live` cannot be undone. To stop quickly, set the cohort back to `dryrun` at `/admin/cohorts`.

---

© 2026 Mirae Lee. This entire work was created by Mirae Lee.
‍​​‌‌​‌​​‌‌​‌‌‌​​​​‌​‌‌‌​‌​‌‌​​‌​‌‌​​‌​​​​​​​​​‌‌​‌‌​‌​​‌​‌‌​​‌​​​‌‌​​​​​‌​‌​​‌‌‌‌‌​‌‌‌‌‌​‌‌‌​‌‌‌‌​​‌​​​‌‌‌‌‌​‌​​‌​‌​​‌‌‌​‌​‌‌​‌​​‌‌​​​​‌‌‌​‌​‌​​​​​‌‌​‌‌‌‌​​‌​‌​‌‌​​‌‌​​‌​‌‌​‌‌‌‌‌​‌​‌‌​‌​​​‌​​​​‌‌‌​​​​​​‌‌‌​‌​‌‌‌‌​​‌​​‌‌‌‌‌​​​‌‌‌​‌​‌​​​​​​​​‌​‌​​​‌‌‌‌​‌‌‌​​‍