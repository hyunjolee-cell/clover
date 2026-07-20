-- ============================================================================
-- CLOVER 패치 01 — 공유공간 생성 오류 수정
--
-- 증상 : 공유공간 생성 시 column reference "space_code" is ambiguous
-- 원인 : 함수의 반환 컬럼 이름 space_code 가 clv_members 테이블의 같은 이름
--        컬럼과 충돌해 on conflict 절에서 어느 쪽인지 판단하지 못함
-- 조치 : 반환 컬럼 이름을 out_space_code / out_version 으로 변경
--
-- 실행 위치 : Supabase Dashboard > SQL Editor > 전체 붙여넣기 후 Run
-- 영향 범위 : clv_create_space 함수 하나만 교체. 데이터·다른 함수 변경 없음
-- ============================================================================

drop function if exists public.clv_create_space(text,text,text,text,text,jsonb);

create function public.clv_create_space(
  p_space_code   text,
  p_secret_hash  text,
  p_space_name   text,
  p_actor        text,
  p_device_id    text,
  p_initial_state jsonb
)
returns table(out_space_code text, out_version bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := upper(trim(p_space_code));
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;
  if v_code = '' or coalesce(trim(p_secret_hash), '') = '' then
    raise exception '공유코드 또는 연결키가 올바르지 않습니다.';
  end if;

  insert into public.clv_spaces(
    space_code, space_name, secret_hash, state, version,
    created_by, updated_by, updated_device
  )
  values (
    v_code, coalesce(nullif(trim(p_space_name), ''), '우리집'), p_secret_hash,
    coalesce(p_initial_state, '{}'::jsonb), 1,
    v_uid, trim(p_actor), p_device_id
  );

  insert into public.clv_members(user_id, space_code, actor, device_id)
  values (v_uid, v_code, trim(p_actor), p_device_id)
  on conflict (user_id, space_code) do update
    set actor = excluded.actor, device_id = excluded.device_id;

  insert into public.clv_audit_logs(
    space_code, actor, user_id, device_id, action, entity_type, summary, after_data
  )
  values (
    v_code, trim(p_actor), v_uid, p_device_id, 'create', 'space',
    '공유공간 생성', jsonb_build_object('space_name', p_space_name)
  );

  return query select v_code, 1::bigint;
end;
$$;

revoke all on function public.clv_create_space(text,text,text,text,text,jsonb) from public, anon;
grant execute on function public.clv_create_space(text,text,text,text,text,jsonb) to authenticated;

-- 확인 (found 9 / expected 9 이면 정상)
select 'functions' as check, count(*) as found, 9 as expected
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'clv\_%';
