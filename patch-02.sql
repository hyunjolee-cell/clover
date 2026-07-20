-- ============================================================================
-- CLOVER 패치 02 — 앱 안에서 바로 비밀번호 재설정
--
-- 배경 : 비밀번호는 해시로만 저장되어 "찾기"가 불가능하다.
--        메일 재설정은 발송 한도와 대기 때문에 부부 둘이 쓰기에 번거롭다.
-- 방법 : 공유공간의 연결키를 아는 사람은 이미 그 집의 가계부를 볼 수 있는 사람이다.
--        연결키 + 그 공간에 속한 계정 이메일, 두 가지가 맞을 때만 비밀번호를 바꾼다.
--
-- 안전장치
--   - 연결키가 틀리면 아무 일도 일어나지 않는다 (계정 존재 여부도 알려주지 않는다)
--   - 그 공유공간의 멤버가 아닌 이메일은 바꿀 수 없다
--   - 바꾼 사실이 변경 로그에 남는다
--
-- 실행 위치 : Supabase Dashboard > SQL Editor > 전체 붙여넣기 후 Run
-- ============================================================================

drop function if exists public.clv_reset_password_with_key(text, text, text, text);

create function public.clv_reset_password_with_key(
  p_space_code   text,
  p_secret_hash  text,
  p_email        text,
  p_new_password text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  v_code  text := upper(trim(p_space_code));
  v_email text := lower(trim(p_email));
  v_uid   uuid;
  v_actor text;
begin
  if length(coalesce(p_new_password, '')) < 6 then
    raise exception '비밀번호는 6자 이상이어야 합니다.';
  end if;

  -- 1) 공유공간과 연결키가 맞는지
  if not exists (
    select 1 from public.clv_spaces s
    where s.space_code = v_code
      and s.secret_hash = p_secret_hash
  ) then
    return false;
  end if;

  -- 2) 그 이메일이 이 공유공간의 멤버인지
  select u.id, m.actor into v_uid, v_actor
  from auth.users u
  join public.clv_members m on m.user_id = u.id
  where lower(u.email) = v_email
    and m.space_code = v_code
  limit 1;

  if v_uid is null then
    return false;   -- 멤버가 아니거나 없는 계정. 어느 쪽인지 알려주지 않는다.
  end if;

  -- 3) 비밀번호 교체
  update auth.users
  set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      updated_at = now()
  where id = v_uid;

  insert into public.clv_audit_logs(
    space_code, actor, user_id, device_id, action, entity_type, summary, after_data
  )
  values (
    v_code, coalesce(v_actor, '알 수 없음'), v_uid, null, 'update', 'settings',
    '연결키로 비밀번호 재설정', jsonb_build_object('email', v_email)
  );

  return true;
end;
$$;

revoke all on function public.clv_reset_password_with_key(text,text,text,text) from public;
grant execute on function public.clv_reset_password_with_key(text,text,text,text) to anon, authenticated;

-- 확인 (found 10 / expected 10 이면 정상)
select 'functions' as check, count(*) as found, 10 as expected
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'clv\_%';
