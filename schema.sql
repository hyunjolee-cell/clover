-- ============================================================================
-- CLOVER — 부부 공동 자산관리 앱 · Supabase 스키마
-- 실행 위치: Supabase Dashboard > SQL Editor > 전체 붙여넣기 후 Run
-- 대상 프로젝트: https://ysoyvoytluacdgivuffl.supabase.co
--
-- 안전성
--   - 생성 객체는 모두 clv_ 접두사. 기존 테이블(cs_responses, audit_logs 등) 무변경
--   - 여러 번 실행해도 같은 결과 (idempotent)
--
-- 선행 조건 (SQL로 불가 — 대시보드에서 수동 설정)
--   Authentication > Providers > Email > "Confirm email" 을 OFF
--   (회원가입 즉시 사용 가능하게 함)
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

-- 공유공간: 부부 한 쌍이 함께 쓰는 데이터 문서 1건
create table if not exists public.clv_spaces (
  space_code     text primary key,
  space_name     text not null default '우리집',
  secret_hash    text not null,               -- 연결키 원문 아님. SHA-256 hex
  state          jsonb not null default '{}'::jsonb,
  version        bigint not null default 0,   -- 낙관적 잠금용
  created_by     uuid not null references auth.users(id) on delete restrict,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text not null default 'system',
  updated_device text
);

-- 멤버십: 어떤 계정이 어떤 공유공간에서 누구(현조/신영)인가
create table if not exists public.clv_members (
  user_id     uuid not null references auth.users(id) on delete cascade,
  space_code  text not null references public.clv_spaces(space_code) on delete cascade,
  actor       text not null,
  device_id   text,
  joined_at   timestamptz not null default now(),
  primary key (user_id, space_code)
);

create index if not exists clv_members_space_idx on public.clv_members(space_code);

-- 변경 로그: 사용자가 지울 수 없는 감사 기록
create table if not exists public.clv_audit_logs (
  id           bigint generated always as identity primary key,
  space_code   text not null references public.clv_spaces(space_code) on delete cascade,
  actor        text not null,
  user_id      uuid,
  device_id    text,
  action       text not null check (action in ('create','update','delete','connect','system')),
  entity_type  text not null,
  entity_id    text,
  summary      text not null,
  before_data  jsonb,
  after_data   jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists clv_audit_logs_space_created_idx
  on public.clv_audit_logs(space_code, created_at desc);

-- ----------------------------------------------------------------------------
-- 2. 행 수준 보안 (RLS)
--    읽기는 "내가 속한 공유공간"만. 쓰기는 아래 RPC(security definer)로만.
-- ----------------------------------------------------------------------------

alter table public.clv_spaces     enable row level security;
alter table public.clv_members    enable row level security;
alter table public.clv_audit_logs enable row level security;

-- 내가 이 공유공간의 멤버인가
create or replace function public.clv_is_member(p_space_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.clv_members m
    where m.space_code = p_space_code
      and m.user_id = auth.uid()
  );
$$;

drop policy if exists clv_spaces_select_member on public.clv_spaces;
create policy clv_spaces_select_member on public.clv_spaces
  for select to authenticated
  using (public.clv_is_member(space_code));

drop policy if exists clv_members_select_own_space on public.clv_members;
create policy clv_members_select_own_space on public.clv_members
  for select to authenticated
  using (user_id = auth.uid() or public.clv_is_member(space_code));

drop policy if exists clv_audit_logs_select_member on public.clv_audit_logs;
create policy clv_audit_logs_select_member on public.clv_audit_logs
  for select to authenticated
  using (public.clv_is_member(space_code));

-- INSERT/UPDATE/DELETE 정책은 의도적으로 만들지 않는다.
-- RLS가 켜져 있고 정책이 없으면 해당 동작은 전부 거부된다.
-- => 로그는 사용자가 수정·삭제할 수 없다. (요구사항 5절)

-- 테이블 직접 권한도 최소화 (Supabase 기본 grant 회수)
revoke all on public.clv_spaces     from anon, authenticated;
revoke all on public.clv_members    from anon, authenticated;
revoke all on public.clv_audit_logs from anon, authenticated;

grant select on public.clv_spaces     to authenticated;
grant select on public.clv_members    to authenticated;
grant select on public.clv_audit_logs to authenticated;

-- ----------------------------------------------------------------------------
-- 3. RPC — 모든 쓰기는 이 경로로만
-- ----------------------------------------------------------------------------

-- 3.1 공유공간 생성 (첫 번째 휴대폰)
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
-- 반환 컬럼 이름을 out_ 로 둔 이유:
-- space_code 로 두면 clv_members 의 같은 이름 컬럼과 충돌해
-- on conflict 절에서 "column reference is ambiguous" 오류가 난다.
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

-- 3.2 공유공간 참여 (두 번째 휴대폰) — 공유코드 + 연결키 해시 검증
drop function if exists public.clv_join_space(text,text,text,text);
create function public.clv_join_space(
  p_space_code  text,
  p_secret_hash text,
  p_actor       text,
  p_device_id   text
)
returns boolean
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

  if not exists (
    select 1 from public.clv_spaces s
    where s.space_code = v_code
      and s.secret_hash = p_secret_hash
  ) then
    return false;   -- 코드·연결키 불일치. 존재 여부를 흘리지 않는다.
  end if;

  insert into public.clv_members(user_id, space_code, actor, device_id)
  values (v_uid, v_code, trim(p_actor), p_device_id)
  on conflict (user_id, space_code) do update
    set actor = excluded.actor, device_id = excluded.device_id;

  insert into public.clv_audit_logs(
    space_code, actor, user_id, device_id, action, entity_type, summary
  )
  values (v_code, trim(p_actor), v_uid, p_device_id, 'connect', 'device', '기기 연결');

  return true;
end;
$$;

-- 3.3 공유공간 조회 — 멤버만
drop function if exists public.clv_read_space(text);
create function public.clv_read_space(p_space_code text)
returns table(
  space_code text, space_name text, state jsonb, version bigint,
  updated_at timestamptz, updated_by text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_space_code));
begin
  if not public.clv_is_member(v_code) then
    raise exception '이 공유공간에 접근할 권한이 없습니다.';
  end if;

  return query
    select s.space_code, s.space_name, s.state, s.version, s.updated_at, s.updated_by
    from public.clv_spaces s
    where s.space_code = v_code;
end;
$$;

-- 3.4 내 멤버십 조회 — 재접속 시 자동 진입용
drop function if exists public.clv_my_membership();
create function public.clv_my_membership()
returns table(space_code text, space_name text, actor text, version bigint)
language sql
stable
security definer
set search_path = public
as $$
  select m.space_code, s.space_name, m.actor, s.version
  from public.clv_members m
  join public.clv_spaces s on s.space_code = m.space_code
  where m.user_id = auth.uid()
  order by m.joined_at desc
  limit 1;
$$;

-- 3.5 저장 — 낙관적 잠금 + 로그를 한 트랜잭션에 기록
drop function if exists public.clv_write_space(text,bigint,jsonb,text,text,text,text,text,text,jsonb,jsonb);
create function public.clv_write_space(
  p_space_code       text,
  p_expected_version bigint,
  p_state            jsonb,
  p_actor            text,
  p_device_id        text,
  p_action           text,
  p_entity_type      text,
  p_entity_id        text,
  p_summary          text,
  p_before_data      jsonb,
  p_after_data       jsonb
)
returns table(version bigint, conflict boolean, updated_at timestamptz, state jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_code    text := upper(trim(p_space_code));
  v_current public.clv_spaces%rowtype;
  v_version bigint;
  v_time    timestamptz;
begin
  if not public.clv_is_member(v_code) then
    raise exception '이 공유공간에 접근할 권한이 없습니다.';
  end if;

  select * into v_current
  from public.clv_spaces s
  where s.space_code = v_code
  for update;

  -- 버전이 다르면 덮어쓰지 않고 최신 상태를 돌려준다 (조용한 덮어쓰기 방지)
  if v_current.version <> p_expected_version then
    return query
      select v_current.version, true, v_current.updated_at, v_current.state;
    return;
  end if;

  update public.clv_spaces s
  set state          = p_state,
      version        = s.version + 1,
      updated_at     = now(),
      updated_by     = trim(p_actor),
      updated_device = p_device_id
  where s.space_code = v_code
  returning s.version, s.updated_at into v_version, v_time;

  insert into public.clv_audit_logs(
    space_code, actor, user_id, device_id, action, entity_type, entity_id,
    summary, before_data, after_data
  ) values (
    v_code, trim(p_actor), v_uid, p_device_id, p_action, p_entity_type,
    p_entity_id, p_summary, p_before_data, p_after_data
  );

  return query select v_version, false, v_time, p_state;
end;
$$;

-- 3.6 로그 조회 — 필터 + 최근 N건
drop function if exists public.clv_read_logs(text,integer,text,text,text);
create function public.clv_read_logs(
  p_space_code  text,
  p_limit       integer default 200,
  p_actor       text default null,
  p_action      text default null,
  p_entity_type text default null
)
returns table(
  id bigint, actor text, device_id text, action text,
  entity_type text, entity_id text, summary text,
  before_data jsonb, after_data jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_space_code));
begin
  if not public.clv_is_member(v_code) then
    raise exception '이 공유공간에 접근할 권한이 없습니다.';
  end if;

  return query
    select l.id, l.actor, l.device_id, l.action, l.entity_type, l.entity_id,
           l.summary, l.before_data, l.after_data, l.created_at
    from public.clv_audit_logs l
    where l.space_code = v_code
      and (p_actor       is null or l.actor       = p_actor)
      and (p_action      is null or l.action      = p_action)
      and (p_entity_type is null or l.entity_type = p_entity_type)
    order by l.created_at desc, l.id desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;

-- 3.7 연결 해제 — 이 계정의 멤버십만 제거 (데이터는 서버에 남음)
drop function if exists public.clv_leave_space(text);
create function public.clv_leave_space(p_space_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_space_code));
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;
  delete from public.clv_members m
  where m.user_id = auth.uid() and m.space_code = v_code;
  return true;
end;
$$;

-- 3.8 이 기기의 사용자(현조/신영) 변경
drop function if exists public.clv_set_actor(text,text,text);
create function public.clv_set_actor(
  p_space_code text,
  p_actor      text,
  p_device_id  text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := upper(trim(p_space_code));
  v_old  text;
begin
  if not public.clv_is_member(v_code) then
    raise exception '이 공유공간에 접근할 권한이 없습니다.';
  end if;

  select m.actor into v_old
  from public.clv_members m
  where m.user_id = v_uid and m.space_code = v_code;

  update public.clv_members m
  set actor = trim(p_actor), device_id = p_device_id
  where m.user_id = v_uid and m.space_code = v_code;

  insert into public.clv_audit_logs(
    space_code, actor, user_id, device_id, action, entity_type,
    summary, before_data, after_data
  ) values (
    v_code, trim(p_actor), v_uid, p_device_id, 'update', 'settings',
    '이 기기 사용자 변경',
    jsonb_build_object('actor', v_old),
    jsonb_build_object('actor', trim(p_actor))
  );

  return true;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. 실행 권한 — 로그인한 사용자만. anon 은 아무것도 못 한다.
-- ----------------------------------------------------------------------------

revoke all on function public.clv_create_space(text,text,text,text,text,jsonb) from public, anon;
revoke all on function public.clv_join_space(text,text,text,text)              from public, anon;
revoke all on function public.clv_read_space(text)                             from public, anon;
revoke all on function public.clv_my_membership()                              from public, anon;
revoke all on function public.clv_write_space(text,bigint,jsonb,text,text,text,text,text,text,jsonb,jsonb) from public, anon;
revoke all on function public.clv_read_logs(text,integer,text,text,text)       from public, anon;
revoke all on function public.clv_leave_space(text)                            from public, anon;
revoke all on function public.clv_set_actor(text,text,text)                    from public, anon;
revoke all on function public.clv_is_member(text)                              from public, anon;

grant execute on function public.clv_create_space(text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.clv_join_space(text,text,text,text)              to authenticated;
grant execute on function public.clv_read_space(text)                             to authenticated;
grant execute on function public.clv_my_membership()                              to authenticated;
grant execute on function public.clv_write_space(text,bigint,jsonb,text,text,text,text,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.clv_read_logs(text,integer,text,text,text)       to authenticated;
grant execute on function public.clv_leave_space(text)                            to authenticated;
grant execute on function public.clv_set_actor(text,text,text)                    to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Realtime — 상대 휴대폰 변경을 새로고침 없이 받기 위한 발행 설정
--    RLS가 걸려 있으므로 멤버가 아닌 사람에게는 이벤트가 가지 않는다.
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'clv_spaces'
  ) then
    alter publication supabase_realtime add table public.clv_spaces;
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 6. 실행 결과 확인 (아래 3줄이 함께 출력되면 정상)
-- ----------------------------------------------------------------------------

select 'tables' as check, count(*) as found, 3 as expected
from information_schema.tables
where table_schema = 'public'
  and table_name in ('clv_spaces','clv_members','clv_audit_logs')
union all
select 'functions', count(*), 9
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'clv\_%'
union all
select 'realtime', count(*), 1
from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'clv_spaces';
