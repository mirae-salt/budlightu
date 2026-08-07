-- Admin notifications table
CREATE TABLE IF NOT EXISTS admin_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,           -- 'receipt_review', 'ocr_failed', 'shortfall', 'invoice_draft', 'support_question', 'receipt_uploaded'
  title TEXT NOT NULL,
  body TEXT,
  bam_id UUID REFERENCES bams(id),
  cohort_id UUID REFERENCES cohorts(id),
  period DATE,
  link TEXT,                    -- admin route to navigate to, e.g. '/admin/receipts'
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IF NOT EXISTS because part of this migration had already been run by hand in the
-- SQL editor, so the indexes existed while the migration was still unrecorded.
CREATE INDEX IF NOT EXISTS idx_admin_notif_read ON admin_notifications(read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notif_created ON admin_notifications(created_at DESC);

-- RLS: service role only (admin data route uses service key)
ALTER TABLE admin_notifications ENABLE ROW LEVEL SECURITY;
