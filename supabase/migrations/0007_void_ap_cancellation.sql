-- P0-5b: when a SENT invoice is voided, auto-generate an AP cancellation email draft.
-- Robin/Jenna review and send the draft manually from admin/invoices/[id]/void.

create or replace function generate_ap_cancellation_draft() returns trigger
language plpgsql as $$
declare
  v_bam_name text;
  v_period_month text;
  v_body text;
  v_program_label text;
  v_po text;
begin
  -- fires only when status changes TO 'void' from 'sent' (already paid → cancel notice needed)
  if TG_OP <> 'UPDATE' then return new; end if;
  if new.status <> 'void' then return new; end if;
  if old.status <> 'sent' then return new; end if;
  if new.void_reason is null then
    raise exception 'void requires void_reason';
  end if;

  select b.first_name || ' ' || b.last_name,
         to_char(new.period, 'FMMonth YYYY'),
         c.program_label,
         c.po_number
    into v_bam_name, v_period_month, v_program_label, v_po
    from bams b
    join cohorts c on c.id = new.cohort_id
   where b.id = new.bam_id;

  v_body := format(
    E'Hi AP team,\n\n'
    'Please DISREGARD invoice %s (%s, %s), previously sent for payment.\n\n'
    'Reason for cancellation: %s\n\n'
    'A corrected invoice will be re-sent under a new number. '
    'Reference: %s · PO# %s.\n\n'
    'Thanks,\nRobin',
    new.invoice_number, v_bam_name, v_period_month, new.void_reason,
    v_program_label, v_po
  );

  insert into ap_cancellations (original_invoice_id, superseded_by, reason, draft_key)
  values (new.id, new.superseded_by, new.void_reason, v_body);

  return new;
end $$;

create trigger invoices_void_creates_cancellation
  after update on invoices
  for each row execute function generate_ap_cancellation_draft();

comment on function generate_ap_cancellation_draft is
  'P0-5b: SENT→void produces an AP cancellation email draft. Robin sends it manually.';
