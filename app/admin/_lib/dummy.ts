/**
 * Dummy data for the scaffold UI. Replace with server queries once wired up.
 * Realistic-ish names mix invented + a few from the real handoff docs so the
 * P0-1 collision case (Lucas + Luke Grabowski → LUCGR / LUKGR) actually shows.
 */

export type BamRow = {
  name: string
  email: string
  cohort: string
  school: string
  status: 'active' | 'pending' | 'archived'
  bank: string
  invoiceCode: string | null
}

export const BAMS: BamRow[] = [
  { name: 'Anastacia Tran',    email: 'anastacia.tran@utoronto.ca', cohort: 'Fall 2026', school: 'U of Toronto',   status: 'active',   bank: 'RBC',        invoiceCode: 'INV-AT1' },
  { name: 'Kira Sabharwal',    email: 'kira.s@queensu.ca',          cohort: 'Fall 2026', school: 'Queen’s U',       status: 'active',   bank: 'TD',         invoiceCode: 'INV-KS1' },
  { name: 'Lucas Grabowski',   email: 'lucas.g13@gmail.com',        cohort: 'Fall 2026', school: 'McMaster',        status: 'active',   bank: 'CIBC',       invoiceCode: 'INV-LUCGR1' },
  { name: 'Luke Grabowski',    email: 'luke.grabowski@yorku.ca',    cohort: 'Fall 2026', school: 'York U',          status: 'active',   bank: 'BMO',        invoiceCode: 'INV-LUKGR1' },
  { name: 'Luke Ducheck',      email: 'lducheck@uwo.ca',            cohort: 'Fall 2026', school: 'Western',         status: 'active',   bank: 'Equitable',  invoiceCode: 'INV-LD1' },
  { name: 'Emma Chen',         email: 'emma.chen@dal.ca',           cohort: 'Fall 2026', school: 'Dalhousie',       status: 'active',   bank: 'Scotiabank', invoiceCode: 'INV-EC1' },
  { name: 'Avery Wong',        email: 'avery.w@ucalgary.ca',        cohort: 'Fall 2026', school: 'U of Calgary',    status: 'active',   bank: 'ATB',        invoiceCode: 'INV-AW1' },
  { name: 'Ian Sullivan',      email: 'ian.sullivan@mtroyal.ca',    cohort: 'Fall 2026', school: 'Mount Royal',     status: 'active',   bank: 'RBC',        invoiceCode: 'INV-IS1' },
  { name: 'Sophia Martin',     email: 'smartin@uottawa.ca',         cohort: 'Fall 2026', school: 'U of Ottawa',     status: 'active',   bank: 'Desjardins', invoiceCode: 'INV-SM1' },
  { name: 'Devon Park',        email: 'devon.park@uwaterloo.ca',    cohort: 'Fall 2026', school: 'Waterloo',        status: 'active',   bank: 'Tangerine',  invoiceCode: 'INV-DP1' },
  { name: 'Marcus Rivera',     email: 'marcus.r@torontomu.ca',      cohort: 'Fall 2026', school: 'Toronto Met',     status: 'pending',  bank: '—',            invoiceCode: null },
  { name: 'Nadia Fischer',     email: 'nadia.f@smu.ca',             cohort: 'Fall 2026', school: 'Saint Mary’s',    status: 'pending',  bank: '—',            invoiceCode: null },
  { name: 'Michelle Cheung',   email: 'm.cheung@carleton.ca',       cohort: 'Summer 2026', school: 'Carleton',      status: 'archived', bank: 'RBC',        invoiceCode: 'INV-MC3' }
]

export type ReceiptRow = {
  bam: string
  uploadedAt: string
  total: string
  reason: string
  status: 'review' | 'ocr_failed'
}

export const REVIEW_QUEUE: ReceiptRow[] = [
  { bam: 'Kira Sabharwal',   uploadedAt: '2 Sep, 4:12 PM',  total: '$147.20', reason: 'Total near max threshold ($150 ± $10)',                    status: 'review' },
  { bam: 'Lucas Grabowski',  uploadedAt: '8 Sep, 11:03 AM', total: '$158.90', reason: 'Ambiguous line: “B.LT 24” — confirm brand',                       status: 'review' },
  { bam: 'Avery Wong',       uploadedAt: '5 Sep, 8:47 PM',  total: '$195.00', reason: 'Near rolling cap (spendable $200, band ± $10)',              status: 'review' },
  { bam: 'Emma Chen',        uploadedAt: '10 Sep, 6:22 PM', total: '$92.00',  reason: 'Below threshold — shortfall risk, confirm with BAM',        status: 'review' },
  { bam: 'Marcus Rivera',    uploadedAt: '14 Sep, 12:41 PM', total: '$155.00',reason: 'Bud Light line confidence 0.72 — low; grocery-mixed receipt', status: 'review' },
  { bam: 'Nadia Fischer',    uploadedAt: '12 Sep, 9:18 AM', total: '—',        reason: 'OCR failed — image too dark; retry 2 of 3',                status: 'ocr_failed' }
]

export type InvoiceRow = {
  number: string
  bam: string
  period: string
  amount: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  flag?: string
}

export const DRAFT_INVOICES: InvoiceRow[] = [
  { number: 'INV-AT1',    bam: 'Anastacia Tran',   period: 'Sept 2026', amount: '$368.75', status: 'draft' },
  { number: 'INV-KS1',    bam: 'Kira Sabharwal',   period: 'Sept 2026', amount: '$368.75', status: 'draft' },
  { number: 'INV-LUCGR1', bam: 'Lucas Grabowski',  period: 'Sept 2026', amount: '$368.75', status: 'draft', flag: 'reimbursement pending REVIEW' },
  { number: 'INV-LUKGR1', bam: 'Luke Grabowski',   period: 'Sept 2026', amount: '$368.75', status: 'draft' },
  { number: 'INV-LD1',    bam: 'Luke Ducheck',     period: 'Sept 2026', amount: '$368.75', status: 'draft' },
  { number: 'INV-EC1',    bam: 'Emma Chen',        period: 'Sept 2026', amount: '$218.75', status: 'draft', flag: 'shortfall — salary only' },
  { number: 'INV-AW1',    bam: 'Avery Wong',       period: 'Sept 2026', amount: '$368.75', status: 'draft', flag: 'reimbursement pending REVIEW' },
  { number: 'INV-IS1',    bam: 'Ian Sullivan',     period: 'Sept 2026', amount: '$368.75', status: 'draft' },
  { number: 'INV-SM1',    bam: 'Sophia Martin',    period: 'Sept 2026', amount: '$368.75', status: 'draft' },
  { number: 'INV-DP1',    bam: 'Devon Park',       period: 'Sept 2026', amount: '$368.75', status: 'draft' }
]

export type CohortRow = {
  name: string
  label: string
  po: string
  months: string
  bams: number
  sendMode: 'dryrun' | 'live'
  status: 'active' | 'ended'
}

export const COHORTS: CohortRow[] = [
  { name: 'Fall 2026',   label: 'BL Campus',       po: '250437', months: 'Sept 2026 — Apr 2027', bams: 58, sendMode: 'dryrun', status: 'active' },
  { name: 'Summer 2026', label: 'BL Summer BAMs',  po: '250437', months: 'May 2026 — Aug 2026',  bams: 7,  sendMode: 'live',   status: 'ended' }
]

export type UnmatchedRow = {
  submittedEmail: string
  submittedAt: string
  reason: string
  matchGuess: string
}

export const UNMATCHED: UnmatchedRow[] = [
  { submittedEmail: 'sara.leo@school.edu',     submittedAt: '30 Aug, 3:42 PM', reason: 'no matching roster email', matchGuess: 'sara.lee@school.edu?' },
  { submittedEmail: 'ianfsulivan@mtroyal.ca',  submittedAt: '31 Aug, 10:11 AM', reason: 'no matching roster email', matchGuess: 'ian.sullivan@mtroyal.ca?' }
]

export type AuditRow = {
  ts: string
  actor: string
  role: 'super_admin' | 'program_admin' | 'system' | 'bam'
  entity: string
  action: string
  target: string
}

export const AUDIT_LOG: AuditRow[] = [
  { ts: '15 Sep, 11:00 PM', actor: 'system',       role: 'system',        entity: 'reimbursement_ledger', action: 'compute',   target: '58 BAMs — Sept 2026' },
  { ts: '15 Sep, 6:41 PM',  actor: 'Robin Graham', role: 'program_admin', entity: 'receipts',             action: 'approved',  target: 'INV-KS1 receipt — override REVIEW' },
  { ts: '15 Sep, 6:38 PM',  actor: 'Robin Graham', role: 'program_admin', entity: 'receipts',             action: 'rejected',  target: 'INV-EC1 receipt — not Bud Light' },
  { ts: '14 Sep, 12:41 PM', actor: 'system',       role: 'system',        entity: 'receipts',             action: 'ocr_review',target: 'INV-MR (Marcus Rivera) — low confidence' },
  { ts: '10 Sep, 6:22 PM',  actor: 'Emma Chen',    role: 'bam',           entity: 'receipts',             action: 'upload',    target: '2 files, sha256 verified' },
  { ts: '3 Sep, 9:15 AM',   actor: 'Mirae Lee',    role: 'super_admin',   entity: 'cohorts',              action: 'update',    target: 'Fall 2026 send_mode: draft → dryrun' },
  { ts: '1 Sep, 8:00 AM',   actor: 'system',       role: 'system',        entity: 'bams',                 action: 'invited',   target: '58 onboarding tokens issued' }
]

export const DASHBOARD_STATS = {
  activeBams:      58,
  receiptsSubmitted: 42,
  reviewQueue:     6,
  budgetUsed:      '$3,215',
  invoicesSent:    0
}
