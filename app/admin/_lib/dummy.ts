/**
 * Dummy data for the scaffold UI. Replace with server queries once wired up.
 * All names are fictional test names — no real people.
 */

export type BamRow = {
  name: string
  email: string
  cohort: string
  school: string
  status: 'active' | 'pending' | 'archived'
  bank: string
  invoiceCode: string | null
  isTest?: boolean
}

export const BAMS: BamRow[] = [
  { name: 'Test BAM Alice',      email: 'alice.test@utoronto.ca',    cohort: 'Fall 2026', school: 'U of Toronto',   status: 'active',   bank: 'RBC',        invoiceCode: 'INV-TBA1' },
  { name: 'Test BAM Bob',        email: 'bob.test@queensu.ca',       cohort: 'Fall 2026', school: "Queen's U",      status: 'active',   bank: 'TD',         invoiceCode: 'INV-TBB1' },
  { name: 'Test BAM Carol',      email: 'carol.test@mcmaster.ca',    cohort: 'Fall 2026', school: 'McMaster',       status: 'active',   bank: 'CIBC',       invoiceCode: 'INV-TBC1' },
  { name: 'Test BAM Dave',       email: 'dave.test@yorku.ca',        cohort: 'Fall 2026', school: 'York U',         status: 'active',   bank: 'BMO',        invoiceCode: 'INV-TBD1' },
  { name: 'Test BAM Eve',        email: 'eve.test@uwo.ca',           cohort: 'Fall 2026', school: 'Western',        status: 'active',   bank: 'Equitable',  invoiceCode: 'INV-TBE1' },
  { name: 'Test BAM Frank',      email: 'frank.test@dal.ca',         cohort: 'Fall 2026', school: 'Dalhousie',      status: 'active',   bank: 'Scotiabank', invoiceCode: 'INV-TBF1' },
  { name: 'Test BAM Grace',      email: 'grace.test@ucalgary.ca',    cohort: 'Fall 2026', school: 'U of Calgary',   status: 'active',   bank: 'ATB',        invoiceCode: 'INV-TBG1' },
  { name: 'Test BAM Hank',       email: 'hank.test@mtroyal.ca',      cohort: 'Fall 2026', school: 'Mount Royal',    status: 'active',   bank: 'RBC',        invoiceCode: 'INV-TBH1' },
  { name: 'Test BAM Iris',       email: 'iris.test@uottawa.ca',      cohort: 'Fall 2026', school: 'U of Ottawa',    status: 'active',   bank: 'Desjardins', invoiceCode: 'INV-TBI1' },
  { name: 'Test BAM Jack',       email: 'jack.test@uwaterloo.ca',    cohort: 'Fall 2026', school: 'Waterloo',       status: 'active',   bank: 'Tangerine',  invoiceCode: 'INV-TBJ1' },
  { name: 'Test BAM Kim',        email: 'kim.test@torontomu.ca',     cohort: 'Fall 2026', school: 'Toronto Met',    status: 'pending',  bank: '—',          invoiceCode: null },
  { name: 'Test BAM Leo',        email: 'leo.test@smu.ca',           cohort: 'Fall 2026', school: "Saint Mary's",   status: 'pending',  bank: '—',          invoiceCode: null },
  { name: 'Test BAM Mia',        email: 'mia.test@carleton.ca',      cohort: 'Fall 2026', school: 'Carleton',     status: 'active',   bank: 'RBC',        invoiceCode: 'INV-TBM1' }
]

export type ReceiptRow = {
  bam: string
  uploadedAt: string
  total: string
  reason: string
  status: 'pending' | 'review' | 'ocr_failed' | 'approved' | 'rejected' | 'auto_pass'
  decidedAt?: string
  decidedReason?: string
}

export const REVIEW_QUEUE: ReceiptRow[] = [
  { bam: 'Test BAM Bob',      uploadedAt: '2 Sep, 4:12 PM',   total: '$147.20', reason: 'Total near threshold ($150 +/- $10)',                        status: 'review' },
  { bam: 'Test BAM Carol',    uploadedAt: '8 Sep, 11:03 AM',  total: '$158.90', reason: 'Ambiguous line: "B.LT 24" -- confirm brand',                status: 'review' },
  { bam: 'Test BAM Grace',    uploadedAt: '5 Sep, 8:47 PM',   total: '$195.00', reason: 'Near rolling cap (spendable $200, band +/- $10)',             status: 'review' },
  { bam: 'Test BAM Frank',    uploadedAt: '10 Sep, 6:22 PM',  total: '$92.00',  reason: 'Below threshold -- shortfall risk',                         status: 'review' },
  { bam: 'Test BAM Kim',      uploadedAt: '14 Sep, 12:41 PM', total: '$155.00', reason: 'Bud Light line confidence 0.72 -- grocery-mixed receipt',    status: 'review' },
  { bam: 'Test BAM Jack',     uploadedAt: '11 Sep, 3:05 PM',  total: '$162.40', reason: 'Multiple receipts -- 3 images, totals differ by $8',         status: 'review' },
  { bam: 'Test BAM Iris',     uploadedAt: '13 Sep, 7:30 PM',  total: '$149.99', reason: 'Tax-inclusive total at exact threshold boundary',            status: 'review' },
  { bam: 'Test BAM Eve',      uploadedAt: '9 Sep, 10:15 AM',  total: '$0.00',   reason: 'Receipt shows $0 -- possible test/void receipt uploaded',   status: 'review' },
  { bam: 'Test BAM Mia',      uploadedAt: '14 Sep, 4:50 PM',  total: '$138.00', reason: 'Below threshold -- summer cohort final month',               status: 'review' },
  { bam: 'Test BAM Leo',      uploadedAt: '12 Sep, 9:18 AM',  total: '—',       reason: 'OCR failed -- image too dark; retry 2 of 3',                status: 'ocr_failed' },
  { bam: 'Test BAM Hank',     uploadedAt: '7 Sep, 2:44 PM',   total: '—',       reason: 'OCR failed -- PDF corrupted / 0 bytes',                     status: 'ocr_failed' },
  { bam: 'Test BAM Dave',     uploadedAt: '6 Sep, 5:33 PM',   total: '—',       reason: 'OCR failed -- non-receipt image (screenshot of text)',       status: 'ocr_failed' },
  { bam: 'Test BAM Kim',      uploadedAt: '13 Sep, 11:05 AM', total: '—',       reason: 'OCR failed -- blurry photo, text unreadable',               status: 'ocr_failed' },
]

export const DECIDED_RECEIPTS: ReceiptRow[] = [
  { bam: 'Test BAM Alice',    uploadedAt: '1 Sep, 2:10 PM',   total: '$148.50', reason: 'Total near threshold ($150 +/- $10)',          status: 'approved',  decidedAt: '15 Sep, 6:30 PM', decidedReason: 'Within acceptable range -- approved' },
  { bam: 'Test BAM Hank',     uploadedAt: '4 Sep, 11:22 AM',  total: '$152.00', reason: 'Ambiguous brand: "BL 12pk"',                   status: 'approved',  decidedAt: '15 Sep, 6:35 PM', decidedReason: 'Confirmed Bud Light 12-pack' },
  { bam: 'Test BAM Iris',     uploadedAt: '3 Sep, 9:00 AM',   total: '$45.00',  reason: 'Below threshold -- shortfall risk',            status: 'approved',  decidedAt: '15 Sep, 6:40 PM', decidedReason: 'BAM confirmed partial month purchase' },
  { bam: 'Test BAM Eve',      uploadedAt: '1 Sep, 5:15 PM',   total: '$160.00', reason: 'Total above cap -- excess flagged',            status: 'approved',  decidedAt: '15 Sep, 6:42 PM', decidedReason: 'Only $150 reimbursed per policy -- excess noted' },
  { bam: 'Test BAM Dave',     uploadedAt: '2 Sep, 3:40 PM',   total: '$151.50', reason: 'Near threshold -- grocery-mixed receipt',      status: 'approved',  decidedAt: '15 Sep, 6:44 PM', decidedReason: 'Bud Light 24-pack line item confirmed' },
  { bam: 'Test BAM Jack',     uploadedAt: '5 Sep, 4:18 PM',   total: '$165.00', reason: 'Non-Bud Light items detected: Coors',          status: 'rejected',  decidedAt: '15 Sep, 6:45 PM', decidedReason: 'Receipt contains only Coors Light -- not Bud Light' },
  { bam: 'Test BAM Grace',    uploadedAt: '2 Sep, 1:30 PM',   total: '$12.00',  reason: 'Bud Light line confidence 0.45 -- very low',   status: 'rejected',  decidedAt: '15 Sep, 6:50 PM', decidedReason: 'Not a Bud Light product -- energy drink receipt' },
  { bam: 'Test BAM Leo',      uploadedAt: '3 Sep, 8:00 AM',   total: '$88.00',  reason: 'Multiple brands detected on receipt',          status: 'rejected',  decidedAt: '15 Sep, 7:00 PM', decidedReason: 'Only $22 of Bud Light on $88 receipt -- below minimum' },
  { bam: 'Test BAM Frank',    uploadedAt: '4 Sep, 10:30 AM',  total: '$142.00', reason: 'Near threshold -- handwritten receipt',         status: 'approved',  decidedAt: '15 Sep, 7:05 PM', decidedReason: 'Handwritten but legible -- Bud Light purchase confirmed by store' },
]

export type InvoiceRow = {
  number: string
  bam: string
  period: string
  amount: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  flag?: string
  receiptStatus?: 'auto_pass' | 'approved' | 'review' | 'rejected' | 'none'
  receiptTotal?: string
}

export const DRAFT_INVOICES: InvoiceRow[] = [
  { number: 'INV-TBA1', bam: 'Test BAM Alice',  period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'approved',  receiptTotal: '$148.50' },
  { number: 'INV-TBB1', bam: 'Test BAM Bob',    period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'review',    receiptTotal: '$147.20' },
  { number: 'INV-TBC1', bam: 'Test BAM Carol',  period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'review',    receiptTotal: '$158.90', flag: 'reimbursement pending REVIEW' },
  { number: 'INV-TBD1', bam: 'Test BAM Dave',   period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'auto_pass', receiptTotal: '$155.00' },
  { number: 'INV-TBE1', bam: 'Test BAM Eve',    period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'auto_pass', receiptTotal: '$162.30' },
  { number: 'INV-TBF1', bam: 'Test BAM Frank',  period: 'Sept 2026', amount: '$218.75', status: 'draft', receiptStatus: 'rejected',  receiptTotal: '$92.00',  flag: 'shortfall -- salary only' },
  { number: 'INV-TBG1', bam: 'Test BAM Grace',  period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'review',    receiptTotal: '$195.00', flag: 'reimbursement pending REVIEW' },
  { number: 'INV-TBH1', bam: 'Test BAM Hank',   period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'approved',  receiptTotal: '$152.00' },
  { number: 'INV-TBI1', bam: 'Test BAM Iris',   period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'approved',  receiptTotal: '$45.00' },
  { number: 'INV-TBJ1', bam: 'Test BAM Jack',   period: 'Sept 2026', amount: '$368.75', status: 'draft', receiptStatus: 'rejected',  receiptTotal: '$165.00' }
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
  { name: 'Fall 2026',   label: 'BL Campus',      po: '260351', months: 'Sep 2026 to Apr 2027', bams: 13, sendMode: 'dryrun', status: 'active' },
]

export type UnmatchedRow = {
  submittedEmail: string
  submittedAt: string
  reason: string
  matchGuess: string
}

export const UNMATCHED: UnmatchedRow[] = [
  { submittedEmail: 'test.typo@school.edu',       submittedAt: '30 Aug, 3:42 PM',  reason: 'no matching roster email', matchGuess: 'test.user@school.edu?' },
  { submittedEmail: 'hank.tset@mtroyal.ca',       submittedAt: '31 Aug, 10:11 AM', reason: 'no matching roster email', matchGuess: 'hank.test@mtroyal.ca?' }
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
  { ts: '15 Sep, 11:00 PM', actor: 'system',         role: 'system',        entity: 'reimbursement_ledger', action: 'compute',    target: '58 BAMs -- Sept 2026' },
  { ts: '15 Sep, 6:41 PM',  actor: 'Program Manager', role: 'program_admin', entity: 'receipts',            action: 'approved',   target: 'INV-TBB1 receipt -- override REVIEW' },
  { ts: '15 Sep, 6:38 PM',  actor: 'Program Manager', role: 'program_admin', entity: 'receipts',            action: 'rejected',   target: 'INV-TBF1 receipt -- not Bud Light' },
  { ts: '14 Sep, 12:41 PM', actor: 'system',         role: 'system',        entity: 'receipts',            action: 'ocr_review', target: 'INV-TBK (Test BAM Kim) -- low confidence' },
  { ts: '10 Sep, 6:22 PM',  actor: 'Test BAM Frank', role: 'bam',           entity: 'receipts',            action: 'upload',     target: '2 files, sha256 verified' },
  { ts: '3 Sep, 9:15 AM',   actor: 'Mirae Lee',      role: 'super_admin',   entity: 'cohorts',             action: 'update',     target: 'Fall 2026 send_mode: draft -> dryrun' },
  { ts: '1 Sep, 8:00 AM',   actor: 'system',         role: 'system',        entity: 'bams',                action: 'invited',    target: '58 onboarding tokens issued' }
]

export const DASHBOARD_STATS = {
  activeBams:        58,
  receiptsSubmitted: 42,
  missingReceipts:   16,
  reviewQueue:       6,
  budgetUsed:        '$3,215 / $8,700',
  invoicesSent:      0,
  pendingOnboarding: 2
}
