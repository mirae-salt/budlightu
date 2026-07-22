/**
 * PDF template — mirrors the real invoice (§A.5).
 * Semantic assertions (not pixel diff): all 19 tokens present, amounts correct, leading zeros preserved.
 * Rendered via @react-pdf/renderer inside the renderInvoicePdf edge function.
 */

import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import type { InvoicePayload } from './invoice-payload'
import * as React from 'react'

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica' },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 12 },
  h2: { fontSize: 12, fontWeight: 'bold', marginTop: 12, marginBottom: 4 },
  row: { flexDirection: 'row', marginBottom: 2 },
  cellLbl: { width: 120, fontWeight: 'bold' },
  cellVal: { flex: 1 },
  linesHeader: {
    flexDirection: 'row',
    borderTop: '1 solid #000',
    borderBottom: '1 solid #000',
    padding: 4,
    marginTop: 12,
    fontWeight: 'bold'
  },
  lineRow: {
    flexDirection: 'row',
    padding: 4,
    borderBottom: '1 solid #ccc'
  },
  col_qty:   { width: 40 },
  col_desc:  { flex: 1 },
  col_unit:  { width: 80, textAlign: 'right' },
  col_total: { width: 80, textAlign: 'right' },
  totals: { marginTop: 8, alignItems: 'flex-end' },
  totalsRow: { flexDirection: 'row', width: 360, justifyContent: 'space-between', marginBottom: 2 },
  totalsLabel: { flex: 1, fontSize: 9 },
  totalsValue: { width: 80, textAlign: 'right' as const },
  footerBox: { marginTop: 24, borderTop: '2 solid #000', paddingTop: 8 }
})

export function InvoicePdf({ payload }: { payload: InvoicePayload }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <Text style={styles.title}>{payload.influencer.name}</Text>

        {/* TO block */}
        <Text style={styles.h2}>TO:</Text>
        <Text>{payload.toBlock.company}</Text>
        <Text>{payload.toBlock.address}</Text>
        <Text>ATTN: {payload.toBlock.attn.join('  ')}</Text>

        {/* Influencer */}
        <Text style={styles.h2}>INFLUENCER MAILING ADDRESS:</Text>
        <Text>{payload.influencer.name}</Text>
        <Text>{payload.influencer.street}</Text>
        <Text>{payload.influencer.cityProvPostal}</Text>
        <Text>{payload.influencer.email}</Text>
        <Text>{payload.influencer.phone}</Text>

        {/* Comments / job */}
        <Text style={styles.h2}>COMMENTS OR SPECIAL INSTRUCTIONS:</Text>
        <Text>{payload.commentsLabel}</Text>
        <Text style={{ marginTop: 4 }}>JOB NUMBER: {payload.jobNumber}</Text>

        {/* Line items */}
        <View style={styles.linesHeader}>
          <Text style={styles.col_qty}>QUANTITY</Text>
          <Text style={styles.col_desc}>DESCRIPTION</Text>
          <Text style={styles.col_unit}>UNIT PRICE</Text>
          <Text style={styles.col_total}>TOTAL</Text>
        </View>

        {payload.lines.map((l, i) => (
          <View key={i} style={styles.lineRow}>
            <Text style={styles.col_qty}>{l.qty}</Text>
            <Text style={styles.col_desc}>{l.description}</Text>
            <Text style={styles.col_unit}>${l.unitPrice.toFixed(2)}</Text>
            <Text style={styles.col_total}>${l.total.toFixed(2)}</Text>
          </View>
        ))}

        {/* Totals */}
        <View style={styles.totals}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>SUBTOTAL</Text>
            <Text style={styles.totalsValue}>${payload.subtotal.toFixed(2)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>TAX (must also share HST number if claiming tax)</Text>
            <Text style={styles.totalsValue}>${payload.tax.toFixed(2)}</Text>
          </View>
          <View style={{ ...styles.totalsRow, borderTop: '1 solid #000', paddingTop: 4, marginTop: 2 }}>
            <Text style={{ ...styles.totalsLabel, fontWeight: 'bold', fontSize: 11 }}>TOTAL</Text>
            <Text style={{ ...styles.totalsValue, fontWeight: 'bold', fontSize: 11 }}>${payload.total.toFixed(2)}</Text>
          </View>
        </View>

        {/* Payable-to + contact */}
        <Text style={styles.h2}>Make all checks payable to: {payload.makeChecksTo}</Text>
        <Text>If you have any questions concerning this invoice, contact: {payload.contact}</Text>

        {/* Direct deposit */}
        <Text style={styles.h2}>DIRECT DEPOSIT INFORMATION</Text>
        <View style={styles.row}><Text style={styles.cellLbl}>BANK</Text>
          <Text style={styles.cellVal}>{payload.directDeposit.bank}</Text></View>
        <View style={styles.row}><Text style={styles.cellLbl}>INSTITUTION NUMBER:</Text>
          <Text style={styles.cellVal}>{payload.directDeposit.institutionNumber}</Text></View>
        <View style={styles.row}><Text style={styles.cellLbl}>TRANSIT NUMBER:</Text>
          <Text style={styles.cellVal}>{payload.directDeposit.transitNumber}</Text></View>
        <View style={styles.row}><Text style={styles.cellLbl}>ACCOUNT NUMBER:</Text>
          <Text style={styles.cellVal}>{payload.directDeposit.accountNumber}</Text></View>
        <View style={styles.row}><Text style={styles.cellLbl}>EMAIL:</Text>
          <Text style={styles.cellVal}>{payload.directDeposit.email}</Text></View>

        {/* Footer */}
        <View style={styles.footerBox}>
          <Text style={{ fontWeight: 'bold' }}>{payload.footer.programTitle}</Text>
          <Text>INVOICE #{payload.footer.invoiceNumber}</Text>
          <Text>DATE: {payload.footer.dateReadable}</Text>
        </View>
      </Page>
    </Document>
  )
}
