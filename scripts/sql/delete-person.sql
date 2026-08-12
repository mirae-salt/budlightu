-- 한 사람 완전 삭제 (명부 + 로그인)
-- Supabase → SQL Editor 에 그대로 붙여넣고, 이메일 한 곳만 바꾸세요.
--
-- ⚠️ 2026-08-12: 이전 버전은 이메일을 네 곳에 바꿔 넣어야 했습니다. auth.users 줄 하나를
--    놓치면 명부만 지워지고 로그인이 남고, 그 사람을 다시 추가해서 초대하면 학생이
--    "A user with this email address has already been registered" 에서 막힙니다.
--    (그 시점엔 초대 토큰이 소진돼서 학생 쪽에서 나갈 길이 없습니다.)
--    이제 이메일은 아래 한 줄에만 있고, 로그인이 안 지워지면 전체가 롤백됩니다.
--
--    참고로 그 막힘 자체도 고쳤습니다 — onboarding-ingest 가 이제 살아남은 로그인을
--    실패가 아니라 "연결"로 처리합니다. 그래도 남은 로그인은 지우는 게 맞습니다.

-- ══ A. 먼저 보기 (아무것도 안 지웁니다) ═════════════════════════════════════
-- 여기도 이메일 한 곳만 바꾸세요. B 를 실행하기 전에 이걸로 확인하세요.
select
  b.email,
  b.first_name || ' ' || b.last_name                                  as name,
  b.status,
  b.is_test,
  (select count(*) from auth.users u where lower(u.email) = lower(b.email)) as has_login,
  (select count(*) from receipts             where bam_id = b.id)      as receipts,
  (select count(*) from invoices             where bam_id = b.id)      as invoices,
  (select count(*) from reimbursement_ledger where bam_id = b.id)      as ledger,
  (select count(*) from bam_warnings         where bam_id = b.id)      as warnings
from bams b
where lower(b.email) = lower('여기에@이메일.com');   -- ← 바꿀 곳 (A)

-- receipts / invoices / ledger / warnings 가 하나라도 0 이 아니면 B 를 실행하지 마세요.
-- 회계 기록이라 지우면 그 달 합계가 조용히 바뀝니다. 대신:
--   update bams set status = 'archived' where lower(email) = lower('여기에@이메일.com');


-- ══ B. 삭제 ════════════════════════════════════════════════════════════════
-- 이메일은 첫 줄 한 곳에만 있습니다. 나머지는 전부 그 변수를 씁니다.
--
-- 전부 아니면 전무입니다: 로그인이 안 지워지면 raise exception 으로 명부 삭제까지
-- 되돌립니다. 반쯤 지워진 상태(= 오늘 그 사고)가 생기지 않습니다.
do $$
declare
  v_email text := '여기에@이메일.com';   -- ← 바꿀 곳 (B, 여기만)
  v_bam uuid;
  v_role text;
  v_blockers int;
  v_bams int;
  v_auth int;
begin
  select id into v_bam from bams where lower(email) = lower(v_email);

  -- 관리자면 멈춥니다. /admin/team 에서 권한을 회수하는 쪽이 맞습니다 —
  -- 그 경로가 test BAM 행 archive 까지 해 줍니다.
  select u.raw_app_meta_data ->> 'role' into v_role
  from auth.users u where lower(u.email) = lower(v_email);
  if v_role in ('super_admin', 'program_admin') then
    raise exception '% 는 % 권한을 가지고 있습니다. /admin/team 에서 권한을 먼저 회수하세요.', v_email, v_role;
  end if;

  if v_bam is null then
    raise notice '명부에 % 가 없습니다. 로그인만 지웁니다.', v_email;
  else
    select
        (select count(*) from receipts             where bam_id = v_bam)
      + (select count(*) from invoices             where bam_id = v_bam)
      + (select count(*) from reimbursement_ledger where bam_id = v_bam)
      + (select count(*) from bam_warnings         where bam_id = v_bam)
    into v_blockers;

    if v_blockers > 0 then
      raise exception '% 는 회계 기록이 %건 있습니다. 지우지 말고 archive 하세요: update bams set status=''archived'' where id=''%'';',
        v_email, v_blockers, v_bam;
    end if;

    -- 참조만 끊습니다. 질문은 익명으로 남기고, 온보딩 제출은 연결만 해제.
    update portal_questions       set bam_id         = null where bam_id         = v_bam;
    update onboarding_submissions set matched_bam_id = null where matched_bam_id = v_bam;

    delete from bams where id = v_bam;
    get diagnostics v_bams = row_count;
    if v_bams <> 1 then
      raise exception '명부에서 %행이 지워졌습니다(1이어야 함). 롤백합니다.', v_bams;
    end if;
  end if;

  -- 로그인. 이게 이전 버전에서 조용히 빠졌던 부분입니다.
  delete from auth.users where lower(email) = lower(v_email);
  get diagnostics v_auth = row_count;

  if v_auth = 0 then
    raise exception '로그인이 지워지지 않았습니다 (auth.users 에서 0행). 전체를 롤백했습니다. Supabase 대시보드 → Authentication → Users 에서 % 를 직접 지우세요.', v_email;
  end if;

  raise notice '완료: 명부 %행, 로그인 %행 삭제', coalesce(v_bams, 0), v_auth;
end $$;


-- ══ C. 확인 (둘 다 0 이어야 합니다) ════════════════════════════════════════
select
  (select count(*) from bams       where lower(email) = lower('여기에@이메일.com')) as bams_left,
  (select count(*) from auth.users where lower(email) = lower('여기에@이메일.com')) as auth_left;
-- ← 바꿀 곳 (C)

-- 그다음 터미널에서:
--   node scripts/probe/can-sign-in.js
--
-- 터미널로 하는 게 편하면 같은 검사·삭제를 하는 스크립트도 있습니다
-- (dry run 이 기본이고, 지운 뒤 읽어서 확인합니다):
--   node scripts/probe/fix-delete-person.js someone@example.com
--   node scripts/probe/fix-delete-person.js someone@example.com --apply
