import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import type { InvoicePayload } from './invoice-payload'
import * as React from 'react'

const BL_BLUE = '#0072CE'

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica', color: '#222' },

  // BAM name top-left
  bamName: { fontSize: 16, color: BL_BLUE, marginBottom: 16 },

  // Blue header bar
  headerBar: {
    backgroundColor: BL_BLUE,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff', textAlign: 'center' },

  // Invoice # / Date right-aligned
  metaRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 20 },
  metaBlock: { textAlign: 'right' },
  metaLabel: { fontSize: 10, fontFamily: 'Helvetica-Bold' },

  // Two-column info
  infoCols: { flexDirection: 'row', marginBottom: 16 },
  infoLeft: { flex: 1, paddingRight: 20 },
  infoRight: { flex: 1 },
  infoHeading: { fontSize: 9, fontFamily: 'Helvetica-Bold', textDecoration: 'underline', marginBottom: 4, textTransform: 'uppercase' as const },
  infoText: { fontSize: 9, lineHeight: 1.5 },
  infoSmallCaps: { fontSize: 8, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' as const },

  // Comments + Job number
  sectionLabel: { fontSize: 9, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' as const, marginTop: 10, marginBottom: 2 },
  commentsText: { fontSize: 9, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' as const },
  jobNumber: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 6, marginBottom: 10 },

  // Line items table
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: BL_BLUE,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  thText: { color: '#fff', fontSize: 9, fontFamily: 'Helvetica-Bold' },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: '#ccc',
  },
  col_qty:   { width: 130 },
  col_desc:  { flex: 1 },
  col_unit:  { width: 80, textAlign: 'right' },
  col_total: { width: 70, textAlign: 'right' },
  cellText: { fontSize: 9 },
  cellBold: { fontSize: 9, fontFamily: 'Helvetica-Bold' },

  // Totals rows (right-aligned within table)
  totalsRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: '#ccc',
  },
  totalsFiller: { flex: 1 },
  totalsLabel: { width: 200, textAlign: 'right', fontSize: 9, paddingRight: 12 },
  totalsLabelItalic: { width: 200, textAlign: 'right', fontSize: 8, paddingRight: 12, fontStyle: 'italic' },
  totalsValue: { width: 70, textAlign: 'right', fontSize: 9 },

  // Footer
  footerSection: { marginTop: 24 },
  footerText: { fontSize: 8.5, lineHeight: 1.6 },
  footerBold: { fontSize: 8.5, fontFamily: 'Helvetica-Bold' },

  // Direct deposit
  ddHeading: { fontSize: 9, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' as const, marginTop: 12, marginBottom: 4 },
  ddRow: { flexDirection: 'row', marginBottom: 1 },
  ddLabel: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', width: 150 },
  ddValue: { fontSize: 8.5 },
})

export function InvoicePdf({ payload }: { payload: InvoicePayload }) {
  const pdfTitle = `${payload.influencer.name} - ${payload.footer.invoiceNumber}`
  return (
    <Document title={pdfTitle}>
      <Page size="LETTER" style={s.page}>
        {/* BAM name top-left */}
        <Text style={s.bamName}>{payload.influencer.name}</Text>

        {/* Blue header bar */}
        <View style={s.headerBar}>
          <Text style={s.headerTitle}>BUD LIGHT CAMPUS INVOICE</Text>
        </View>

        {/* Invoice # and Date — right-aligned */}
        <View style={s.metaRow}>
          <View style={s.metaBlock}>
            <Text style={s.metaLabel}>INVOICE #{payload.footer.invoiceNumber}</Text>
            <Text style={s.metaLabel}>DATE: {payload.footer.dateReadable}</Text>
          </View>
        </View>

        {/* Two-column info block */}
        <View style={s.infoCols}>
          {/* Left: TO block */}
          <View style={s.infoLeft}>
            <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 2 }}>To:</Text>
            <Text style={s.infoText}>{payload.toBlock.company}</Text>
            <Text style={s.infoText}>{payload.toBlock.address}</Text>
            <Text style={s.infoText}>ATTN: {payload.toBlock.attn[0]}</Text>
            <Text style={s.infoText}>{payload.toBlock.attn[1]}</Text>
          </View>

          {/* Right: Influencer mailing address */}
          <View style={s.infoRight}>
            <Text style={s.infoHeading}>Influencer Mailing Address:</Text>
            <Text style={s.infoText}>{payload.influencer.name}</Text>
            <Text style={s.infoText}>{payload.influencer.street}</Text>
            <Text style={s.infoText}>{payload.influencer.cityProvPostal}</Text>
            <Text style={{ ...s.infoText, marginTop: 4 }}>{payload.influencer.email}</Text>
            <Text style={s.infoText}>{payload.influencer.phone}</Text>
          </View>
        </View>

        {/* Comments */}
        <Text style={s.sectionLabel}>Comments or special instructions:</Text>
        <Text style={s.commentsText}>{payload.commentsLabel}</Text>

        {/* Job Number */}
        <Text style={s.jobNumber}>JOB NUMBER: {payload.jobNumber}</Text>

        {/* Line items table header */}
        <View style={s.tableHeader}>
          <Text style={{ ...s.thText, ...s.col_qty }}>QUANTITY</Text>
          <Text style={{ ...s.thText, ...s.col_desc }}>DESCRIPTION</Text>
          <Text style={{ ...s.thText, ...s.col_unit }}>UNIT PRICE</Text>
          <Text style={{ ...s.thText, ...s.col_total }}>TOTAL</Text>
        </View>

        {/* Line items */}
        {payload.lines.map((l, i) => (
          <View key={i} style={s.tableRow}>
            <View style={s.col_qty}>
              <Text style={s.cellText}>{l.qty === 1 ? lineLabel(l.description) : String(l.qty)}</Text>
            </View>
            <View style={s.col_desc}>
              <Text style={s.cellText}>{lineDesc(l.description)}</Text>
            </View>
            <Text style={{ ...s.cellText, ...s.col_unit }}>${l.unitPrice.toFixed(2)}</Text>
            <Text style={{ ...s.cellText, ...s.col_total }}>${l.total.toFixed(2)}</Text>
          </View>
        ))}

        {/* SUBTOTAL */}
        <View style={s.totalsRow}>
          <View style={s.totalsFiller} />
          <Text style={s.totalsLabel}>SUBTOTAL</Text>
          <Text style={s.totalsValue}>${payload.subtotal.toFixed(2)}</Text>
        </View>

        {/* TAX */}
        <View style={s.totalsRow}>
          <View style={s.totalsFiller} />
          <Text style={s.totalsLabelItalic}>TAX (must also share HST number if claiming tax)</Text>
          <Text style={s.totalsValue}>${payload.tax === 0 ? '0' : payload.tax.toFixed(2)}</Text>
        </View>

        {/* TOTAL */}
        <View style={{ ...s.totalsRow, borderBottomWidth: 0 }}>
          <View style={s.totalsFiller} />
          <Text style={{ ...s.totalsLabel, fontFamily: 'Helvetica-Bold' }}>TOTAL</Text>
          <Text style={{ ...s.totalsValue, fontFamily: 'Helvetica-Bold' }}>${payload.total.toFixed(2)}</Text>
        </View>

        {/* Footer: payable-to + contact */}
        <View style={s.footerSection}>
          <Text style={s.footerText}>Make all checks payable to: {payload.makeChecksTo}</Text>
          <Text style={s.footerText}>
            If you have any questions concerning this invoice, contact:  {payload.contact}
          </Text>

          {/* Direct Deposit Information */}
          <Text style={s.ddHeading}>Direct Deposit Information</Text>
          <View style={s.ddRow}>
            <Text style={s.ddLabel}>BANK – {payload.directDeposit.bank}</Text>
          </View>
          <View style={s.ddRow}>
            <Text style={s.ddLabel}>INSTITUTION NUMBER:</Text>
            <Text style={s.ddValue}>{payload.directDeposit.institutionNumber}</Text>
          </View>
          <View style={s.ddRow}>
            <Text style={s.ddLabel}>TRANSIT NUMBER:</Text>
            <Text style={s.ddValue}>{payload.directDeposit.transitNumber}</Text>
          </View>
          <View style={s.ddRow}>
            <Text style={s.ddLabel}>ACCOUNT NUMBER:</Text>
            <Text style={s.ddValue}>{payload.directDeposit.accountNumber}</Text>
          </View>
          <View style={s.ddRow}>
            <Text style={s.ddLabel}>EMAIL:</Text>
            <Text style={s.ddValue}>{payload.directDeposit.email}</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}

function lineLabel(desc: string): string {
  if (/monthly payment/i.test(desc)) return 'Monthly Payment'
  if (/reimbursement/i.test(desc)) return 'Sponsorship Allowance\nReimbursement'
  return ''
}

function lineDesc(desc: string): string {
  const monthMatch = desc.match(/\((\w+ Payment)\)/i)
  if (monthMatch && /monthly payment/i.test(desc)) {
    return `Brand Activation Manager monthly payment (${monthMatch[1]})`
  }
  const reimMatch = desc.match(/\((\w+)\)\s*$/i)
  if (reimMatch && /reimbursement/i.test(desc)) {
    return `Reimbursement for sponsorship allowance (${reimMatch[1]})`
  }
  return desc
}
