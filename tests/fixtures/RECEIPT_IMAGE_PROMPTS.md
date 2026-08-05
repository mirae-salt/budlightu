# Receipt Image Generation Prompts (OCR Test Fixtures)

> 이 프롬프트들을 AI 이미지 생성 도구(DALL-E 3, Midjourney, Flux 등)에 입력하여
> OCR 파이프라인 테스트용 합성 영수증 이미지를 만든다.
> 각 프롬프트는 `classifyReceipt()` 및 `ocrReceipt` Edge Function의 특정 엣지케이스를 커버한다.

---

## 1. REVIEW — Bud Light 전용 영수증, $150 초과 (무조건 플래그)

```
A high-resolution photograph of a Canadian retail receipt on white thermal paper,
slightly curled at the edges. The receipt is from "LCBO #0247" located at
"1245 Dundas St W, Toronto ON M6J 1X6". Date: "2026-09-28 14:32".

Line items printed in a monospaced dot-matrix font:
- BUD LIGHT 24 PACK CAN     $39.95
- BUD LIGHT LIME 12PK       $22.95
- BUD LIGHT SELTZER MIX 12  $24.95
- BUD LIGHT LAGER 6X473ML   $16.95
- BUD LIGHT PLATINUM 6PK    $18.95
- BUD LIGHT CHELADA 6X355   $17.95
- BUD LIGHT APPLE 12PK      $24.95

Subtotal: $166.65
HST 13%:   $21.66
Total:    $188.31

Payment: VISA ****6411
"THANK YOU / MERCI"

The receipt is placed on a dark wood table surface, photographed from directly
above with even lighting. No other items in frame. Realistic thermal print
quality with slight ink variation.
```

**Expected**: `status: 'review'` (total $166.65 >= $150 cap — always flagged)

---

## 2. REVIEW — 정확히 $150 경계 영수증 (>= cap = 무조건 플래그)

```
A photograph of a Canadian liquor store receipt on white thermal paper.
Store: "Beer Store #4421", "890 College St, Toronto ON".
Date: "2026-09-05 17:45".

Items in standard POS thermal print:
- BL TALL CAN 6X473ML CAN    $16.95
- BL SELTZER MIX 12UC         $24.95
- BUD LT LIME 24UC            $42.95
- BUD LIGHT LAGER 15X355      $27.95
- BL STRAWBERRY LEMON 6TC     $14.95
- BUD LIGHT LIME TIME 6PK     $14.95
- BUD LT SELTZER MIX 24UC     $7.95

Subtotal: $150.65
HST 13%:   $19.58
Total:    $170.23

Payment: DEBIT
"Thank you for shopping at The Beer Store"

Receipt placed on a kitchen counter, slightly crumpled, photographed at a
slight angle. Natural indoor lighting.
```

**Expected**: `status: 'review'` ($150.65 >= $150)

---

## 3. REVIEW — 리뷰 밴드 내 ($140–$149) + 9월 영수증

```
A photograph of a Canadian convenience store receipt, thermal paper.
Store: "Couche-Tard #8812", "2150 Rue Sainte-Catherine O, Montreal QC H3H 1M7".
Date: "2026-09-15 20:12".

French POS formatting:
- BUDLIG.BIERE CAN 24X355    $39.95
- BUDLISELT.EAU P. 12X355    $22.95
- BUDLIG.PR.PARTN. 6X355     $14.95
- BUD LT CHELADA 12X355      $28.95
- BUDLIG.LIME 12X355          $22.95
- BUD LIGHT GOLD 6X473        $16.95

Sous-total: $146.70
TPS 5%:      $7.34
TVQ 9.975%: $14.63
Total:     $168.67

Paiement: COMPTANT / CASH $170.00
Monnaie:   $1.33

Receipt on a white desk, flat, well-lit. Clean and legible.
```

**Expected**: `status: 'review'` (in $140-$150 review band)

---

## 4. FAIL — 미달 ($0 Bud Light)

```
A photograph of a Canadian grocery store receipt, long thermal paper.
Store: "Loblaws #1042", "585 Queen St W, Toronto ON M6J 1E8".
Date: "2026-09-22 11:05".

Mixed grocery items:
- ORGANIC BANANAS 1.2kg       $2.49
- WHOLE WHEAT BREAD            $4.29
- PC CHICKEN BREAST 1kg       $14.99
- GREEK YOGURT 750g            $6.49
- CORONA EXTRA 12PK           $22.95
- WHITE CLAW VARIETY 12PK     $24.95
- SMIRNOFF ICE 6PK            $12.95
- PALM BAY VARIETY 12PK       $19.95
- COTTAGE SPRINGS 12PK        $22.95
- MILK 2% 4L                   $6.79
- COORS SELTZER 12PK          $21.95

Subtotal: $160.75
HST 13%:   $20.90
Total:    $181.65

Payment: MC ****2288

Receipt photographed on a grey granite countertop with natural light.
Slightly wrinkled but fully legible.
```

**Expected**: `status: 'rejected'` (no Bud Light items, bud_light_total = $0)

---

## 5. MIXED — 혼합 영수증 (Bud Light + 다른 제품)

```
A photograph of a Canadian retail receipt from "Real Canadian Superstore #2201",
"3585 Portage Ave, Winnipeg MB R3K 0Z8".
Date: "2026-09-08 16:30".

Items:
- BUD D LIME 12X355ML         $22.95
- BUDWEISER 24X355ML          $39.95
- BUD LIGHT 15X355ML          $27.95
- TWISTED TEA 12PK            $22.95
- CORONA LIGHT 12PK           $21.95
- BUD LIGHT SELTZER 12PK      $24.95
- MICHELOB ULTRA 12PK         $22.95
- BUD LIGHT CHELADA 6PK       $14.95
- CHIPS DORITOS                 $4.49
- SALSA MEDIUM                  $3.99

Subtotal: $207.08
GST 5%:    $10.35
PST 7%:    $14.50
Total:    $231.93

Payment: VISA ****8832

Receipt on a wooden kitchen table, slight shadow on right edge.
```

**Expected**: Bud Light total = $22.95 + $27.95 + $24.95 + $14.95 = $90.80
(Budweiser/Michelob/Twisted Tea/Corona are NOT Bud Light)
`status: 'auto_pass'` if confidence high enough

---

## 6. EDGE — 열화/흐릿한 영수증 (낮은 신뢰도)

```
A photograph of a heavily faded Canadian thermal receipt that has been left in
sunlight. The text is partially illegible — some characters are barely visible.
The receipt is from an LCBO store.

Partially readable items (some text very faint):
- BUD LI[faded]T 24PK         $39.[faded]5
- BUD [almost invisible] 12PK $2[faded].95
- [completely faded line]
- BUD LIGHT S[faded]ZER       $24.95

The bottom of the receipt is cut off — no total visible.
Receipt is wrinkled and has a water stain in the lower right corner.
Photographed under dim fluorescent lighting on a dark surface.
```

**Expected**: `status: 'review'` (low overall_confidence < 0.85)

---

## 7. EDGE — 바/레스토랑 영수증

```
A photograph of a restaurant bill/tab receipt from "The Loose Moose",
"146 Front St W, Toronto ON M5J 1G2".
Date: "2026-09-20 23:45". Server: "ALEX T."

Items:
- 16oz DFT Bud Light          $9.50
- 16oz DFT Bud Light          $9.50
- Can Bud Light               $8.00
- Can Bud Light               $8.00
- Wings (12pc)                $18.95
- Nachos Grande               $16.95
- 16oz DFT Guinness           $10.50
- Can Bud Light               $8.00

Subtotal: $89.40
HST 13%:  $11.62
Total:   $101.02
Tip:      $15.00
Grand Total: $116.02

"Thank you! Please come again!"

Receipt is a standard white restaurant receipt (not thermal), printed in
a serif font. Placed on a dark bar surface, slightly out of focus on edges.
```

**Expected**: Bud Light total = $9.50 + $9.50 + $8.00 + $8.00 + $8.00 = $43.00
(Wings/Nachos/Guinness excluded). `receipt_type: 'bar_restaurant'`

---

## 8. EDGE — 온라인 주문/배달앱 스크린샷

```
A screenshot of a delivery order confirmation from Uber Eats, displayed on a
phone screen. The order is from "LCBO Express" in Toronto.

Order items:
- Bud Light Light Beer Cans 24x355ml    $39.95
- Bud Light Lime Cans 12x355ml          $22.95
- Bud Light Seltzer Variety 12x355ml    $24.95

Subtotal:        $87.85
Service Fee:      $4.39
Delivery Fee:     $3.99
Small Order Fee:  $0.00
HST:             $12.51
Total:          $108.74

Payment: Apple Pay
Order #UE-8842-LCBO

The screenshot shows a white background with Uber Eats branding (green header).
Phone screen bezels visible around edges.
```

**Expected**: Bud Light total = $87.85, `receipt_type: 'online_order'` or `'delivery_app'`

---

## 9. EDGE — 열감지 인쇄 오류 (OCR 아티팩트)

```
A photograph of a Canadian LCBO receipt with visible thermal printing artifacts.
The receipt has been partially exposed to heat, causing some characters to
distort.

Store: "LCBO #0582", "1515 Bayview Ave, Toronto ON".
Date: "2026-09-12 13:22".

Items with realistic thermal print defects:
- BUD LIOT 24X355ML CAN       $39.95    (thermal artifact: G→O)
- BUD L1AT LIME 12PK          $22.95    (thermal artifact: GH→1A)
- BJD LIGHT SELTZER 12PK      $24.95    (thermal artifact: U→J)
- BUD LIGHT CHELADA 6PK       $14.95    (printed correctly)

Subtotal: $102.80
HST 13%:   $13.36
Total:    $116.16

The receipt has a slight pink/brown discoloration from heat exposure.
Some characters have merged or shifted slightly. Photographed flat on
a white surface with overhead lighting.
```

**Expected**: OCR should recognize thermal artifacts as Bud Light variants.
All 4 items = `is_bud_light: true`. Confidence may be lower on distorted lines.

---

## 10. EDGE — 영수증이 아닌 이미지 (not_a_receipt)

```
A photograph of a handwritten grocery shopping list on a yellow legal pad.
The list includes:
- Bud Light 24pk
- Chips
- Salsa
- Paper towels
- Bud Light Lime 12pk

The handwriting is casual cursive, written with a blue ballpoint pen.
The legal pad is on a kitchen counter with a magnet and a pen beside it.
Natural morning light from a window.
```

**Expected**: `receipt_type: 'not_a_receipt'`, no valid line items to OCR

---

## 11. EDGE — Alberta 영수증 (GST 5% only, no PST)

```
A photograph of a Canadian liquor store receipt from "Calgary Co-op Wine Spirits Beer #12",
"7740 18 St SE, Calgary AB T2C 4E4".
Date: "2026-09-18 19:55".

Items:
- BUD LIME 15X355ML           $27.95
- BUD DBL LIME 12X355         $22.95
- BUD LIGHT LAGER 24PK        $39.95
- BUD LIGHT APPLE 12PK        $24.95

Subtotal: $115.80
GST 5%:     $5.79
Total:    $121.59

Payment: TAP VISA

Receipt on a light grey desk surface. Clean, crisp thermal print.
```

**Expected**: Alberta = GST 5% only (no PST/HST). Tax calculation should use 5%.

---

## 12. EDGE — Nova Scotia 영수증 (HST 15%)

```
A photograph of a Canadian NSLC (Nova Scotia Liquor Corporation) receipt.
Store: "NSLC #1020", "5540 Spring Garden Rd, Halifax NS B3J 1G6".
Date: "2026-09-10 15:10".

Items:
- BUD LIGHT 12X355ML CAN      $22.95
- BUD LIGHT SELTZER 12PK      $24.95
- BUD LIGHT LIME 6X355ML      $14.95
- BUD LIGHT PLATINUM 6PK      $18.95

Subtotal:  $81.80
HST 15%:   $12.27
Total:     $94.07

"Enjoy Responsibly / Consommez avec modération"

Receipt slightly curled, on a dark surface.
```

**Expected**: Nova Scotia = HST 15%. Province detection for tax validation.

---

## 13. EDGE — 중복 해시 테스트용 동일 영수증 2장

```
Two identical Canadian Beer Store receipts placed side by side on a white
surface. Both receipts are from "Beer Store #4421" with identical items,
date "2026-09-25 14:00", and total $89.85.

Items on each:
- BL TALL CAN 6X473ML         $16.95
- BUD LT LIME 12UC            $22.95
- BUD LIGHT LAGER 24X355      $39.95
- BL SELTZER MIX 6TC          $9.95

Each receipt has identical barcodes at the bottom.
Photographed from above, receipts touching but not overlapping.
```

**Expected**: If both are submitted, second triggers `duplicateHash: true` → `status: 'review'`

---

## 14. EDGE — 날짜 불일치 (다른 달 영수증 제출)

```
A photograph of a Canadian LCBO receipt on white thermal paper.
Store: "LCBO #0315", "2232 Bloor St W, Toronto ON M6S 1N6".
Date: "2026-08-17 14:20".

Items in standard POS thermal print:
- BUD LIGHT 24X355ML CAN       $39.95
- BUD LIGHT SELTZER 12PK       $24.95
- BUD LIGHT LIME 6X355ML       $14.95

Subtotal: $79.85
HST 13%:  $10.38
Total:    $90.23

Payment: DEBIT TAP
"THANK YOU / MERCI"

Receipt on a white desk, clean and legible. No wrinkles.
```

**Expected**: If submitted for September period, `date mismatch` fraud flag fires
(receipt dated August, submitted for September). Routes to `status: 'review'`.

---

## 사용법

1. 위 프롬프트를 이미지 생성 도구에 입력하여 합성 영수증 이미지를 생성한다.
2. 생성된 이미지를 `tests/fixtures/receipts/` 디렉토리에 저장한다.
3. `ocrReceipt` Edge Function으로 OCR 처리 후 `classifyReceipt()` 결과를 검증한다.

### 파일 명명 규칙
```
receipt-01-review-lcbo-allbudlight-over150.jpg
receipt-02-review-boundary-150.jpg
receipt-03-review-band-couche-tard.jpg
receipt-04-fail-no-budlight.jpg
receipt-05-mixed-superstore.jpg
receipt-06-faded-low-confidence.jpg
receipt-07-bar-restaurant.jpg
receipt-08-delivery-app-screenshot.jpg
receipt-09-thermal-artifacts.jpg
receipt-10-not-a-receipt.jpg
receipt-11-alberta-gst-only.jpg
receipt-12-nova-scotia-hst15.jpg
receipt-13-duplicate-hash-pair.jpg
receipt-14-date-mismatch-august.jpg
```
