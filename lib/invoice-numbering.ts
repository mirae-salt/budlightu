/**
 * Invoice number formatter + AP subject / filename generators.
 * Sequence assignment happens in DB (SELECT FOR UPDATE + UNIQUE indexes);
 * this module only builds strings.
 */

export function formatInvoiceNumber(initialsResolved: string, seq: number): string {
  if (!/^[A-Z]{2,10}$/.test(initialsResolved)) {
    throw new Error(`initials_resolved must be 2–10 uppercase letters, got ${JSON.stringify(initialsResolved)}`)
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`seq must be positive integer, got ${seq}`)
  }
  return `INV-${initialsResolved}${seq}`
}

/** "Alex Kim - July 2026 - Invoice #INV-AK1" */
export function invoiceDisplayName(firstName: string, lastName: string, period: Date, invoiceNumber: string): string {
  const month = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const year = period.getUTCFullYear()
  return `${firstName} ${lastName} - ${month} ${year} - Invoice #${invoiceNumber}`
}

/** AP email subject per §A.6: "FIRSTNAME LASTNAME MONTH Invoice #{seq or number}" */
export function apEmailSubject(firstName: string, lastName: string, period: Date, invoiceNumber: string): string {
  const month = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  return `${firstName} ${lastName} ${month} Invoice #${invoiceNumber}`
}

/** AP email body: only PROGRAM_LABEL and PO_NUMBER are variable. */
export function apEmailBody(month: string, programLabel: string, poNumber: string): string {
  return [
    'Hi there,',
    '',
    `Attached is a ${month} invoice for our Bud Light BAM.`,
    'Please maintain net15 payment terms with direct deposit.',
    '',
    `This is from ${programLabel} - PO# ${poNumber}.`,
    '',
    'Thanks,',
    'Program Team'
  ].join('\n')
}

/** PDF filename — same as invoiceDisplayName + .pdf */
export function invoicePdfFilename(firstName: string, lastName: string, period: Date, invoiceNumber: string): string {
  return `${invoiceDisplayName(firstName, lastName, period, invoiceNumber)}.pdf`
}
