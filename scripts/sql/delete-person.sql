-- 한 사람 완전 삭제. 이메일만 바꾸면 됩니다.
-- 실제 참가자는 쓰지 마세요 (영수증·인보이스는 회계 기록). archive가 맞습니다:
--   update bams set status='archived' where lower(email)=lower('...');

-- ══ A. AUDIT — 뭐가 딸려 있는지 먼저 본다 ═══════════════════════════════════
select b.email, b.first_name||' '||b.last_name as name, b.status, b.is_test,
       b.auth_user_id is not null                                     as has_login,
       (select count(*) from receipts             where bam_id=b.id)  as receipts,
       (select count(*) from invoices             where bam_id=b.id)  as invoices,
       (select count(*) from reimbursement_ledger where bam_id=b.id)  as ledger,
       (select count(*) from bam_warnings         where bam_id=b.id)  as warnings,
       (select count(*) from portal_questions     where bam_id=b.id)  as questions
from bams b
where lower(b.email) = lower('여기에@이메일.com');      -- ← 바꿀 곳

-- receipts / invoices / ledger / warnings 가 0이 아니면 여기서 멈추세요.


-- ══ B. DELETE — 위가 전부 0일 때만 ═════════════════════════════════════════
begin;

  -- 참조만 끊는 것들 (질문은 익명으로 남김)
  update portal_questions       set bam_id         = null where bam_id         = (select id from bams where lower(email)=lower('여기에@이메일.com'));
  update onboarding_submissions set matched_bam_id = null where matched_bam_id = (select id from bams where lower(email)=lower('여기에@이메일.com'));

  -- 명부 행
  delete from bams where lower(email) = lower('여기에@이메일.com');

  -- 로그인 계정 (role claim도 여기 있으므로 같이 사라짐)
  delete from auth.users where lower(email) = lower('여기에@이메일.com');

commit;
-- receipts/invoices가 남아 있으면 여기서 FK 에러가 나고 전체가 롤백됩니다. 그게 안전장치입니다.


-- ══ C. 확인 ════════════════════════════════════════════════════════════════
select (select count(*) from bams       where lower(email)=lower('여기에@이메일.com')) as bams_left,
       (select count(*) from auth.users where lower(email)=lower('여기에@이메일.com')) as auth_left;
-- 둘 다 0. 그다음 터미널에서: node scripts/probe/can-sign-in.js
