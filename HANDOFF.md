# Bud Light U — invoice automation, handoff

**Built and maintained by Mirae Lee** (mirae.lee@ilovesalt.com) — sole developer.

운영 매뉴얼. 무엇을 하는 시스템이고, 어떻게 돌리고, 뭘 만지면 되는지. 설계 이유는 담지 않는다.

---

## 1. What it does

BAM(캠퍼스 앰버서더)에게 매달 개별 인보이스로 지급한다. 화면은 둘이다.

- **BAM 포털** — 학생이 로그인해 영수증을 올리고, 인보이스를 보고, 문의한다.
- **어드민 대시보드** — Robin이 플래그된 영수증을 검토하고, 인보이스를 일괄 승인한다.

영수증 판독, 환급 계산, 인보이스 번호·렌더, AP 이메일, PDF 저장은 자동이다. 사람이 개입하는
건 둘, 둘 다 Robin이다. 영수증 검토(AI가 못 정한 것)와 일괄 승인(초안으로 생성된 인보이스를
승인하면 발송).

---

## 2. Where things live

| Thing | Where | Account |
|---|---|---|
| App (Next.js) | Vercel | Mirae's Vercel |
| DB · auth · storage | Supabase | Shane's Supabase |
| Email | Resend | Salt |
| 영수증 판독 (AI) | OpenRouter | Salt |
| Code | github.com/mirae-salt/budlightu (private) | Mirae |

로그인·도메인 상세는 공유 자격증명 스프레드시트에 있고 이 저장소엔 없다. 인보이스 PDF는
Supabase `invoices` 버킷에 저장된다.

---

## 3. Running it

```bash
npm install
npm run dev          # localhost:3000
```

`.env.local`은 저장소에 없다. 필요한 키: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`,
`SUPABASE_ACCESS_TOKEN`, `RESEND_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
`NEXT_PUBLIC_APP_URL`.

푸시 전:

```bash
npm run typecheck && npm test && npm run build
```

`main` 푸시 시 자동 배포. DB 변경은 `supabase/migrations/`의 SQL을 `npm run db:migrate`로 적용.

---

## 4. The monthly cycle

Vercel cron이 매일 13:00 UTC에 `/api/cron`을 친다. 날짜로 할 일을 정한다.

| Day | What happens |
|---|---|
| 15th | 영수증 마감. 이후 업로드 거부 |
| 16th | 영수증 감사. 불명확한 건 Robin 검토 큐로 (touchpoint 1) |
| 17th | 인보이스 초안 생성. Robin 일괄 승인 → AP (touchpoint 2) |
| 매일 | 대기 중인 게 있으면 Robin에게 다이제스트 메일 |

영수증이 미결이면 인보이스는 나가지 않는다(fail closed). 16·17일은 같은 날로 합치지 않는다.

---

## 5. What Robin can change (no developer)

`/admin` 아래에서 바꾼다. AP 이메일·CC, 문의 알림 빈도, 학생 리마인더(off/draft/live),
유지보수 배너, PO·날짜·발송 모드(Cohorts), 로스터·CSV 임포트. `policy` 테이블 값은 저장 즉시
반영된다. Robin용 안내는 실행 앱의 `/admin/guide`.

---

## 6. Sending real email

코호트마다 `send_mode`가 있다. `dryrun`(현재, 발송 안 함) / `live`(실제 발송). `live`는
되돌릴 수 없다. 급히 멈추려면 `/admin/cohorts`에서 `dryrun`으로 되돌린다.

---

© 2026 Mirae Lee (이미래). This entire work was created by Mirae Lee.
이 저작물 전체는 이미래가 만들었습니다.
‍‌​​‌​​‌‌​‌​‌​‌‌‌​​​​​​​​‌​‌‌‌​​​​​​​‌​​‌‌​‌​‌‌‌​​​‌‌‌​​‌​​‌‌‌‌‌​‌​​​‌​‌‌‌‌​​​​​‌​‌​‌‌​‌‌‌​‌​‌​‌‌‌‌‌‌‌​​​‌​‌​‌‌‌‌​‌​‌​‌‌​‌​‌​​​‌‌​‌​​​​‌​​‌‌‌​‌​‌‌​‌​​‌‌‌‌​‌​‌​​​‌‌​‌‌​‌‌​​‌​​‌‌‌‌​​‌‌‌‌​​​​​​​​​‌​​‌​​​​‌‌​‌​‌​​‌‌​​​​​​‌​‌​​​​‌​‌​‌‌​​​‌‌‌‌‌‌‌‌​‌​​‌​​​​​‌‌​‌​​‍