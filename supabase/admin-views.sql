-- Trove 요약 보기(Seo 전용). 0001_init.sql 다음에 Supabase › SQL Editor 에서 실행.
-- 다시 실행해도 안전해요(보기만 지웠다 다시 만들어요. 데이터는 건드리지 않아요).
--
-- * admin 스키마는 Data API(앱이 쓰는 /rest/v1)에 노출하지 않는 스키마예요. anon·authenticated 에게 권한을 주지 않아서
--   앱이나 publishable 키로는 읽을 수 없고, 대시보드 SQL Editor(postgres 권한)에서만 봐요.
--   Settings › Data API 의 Exposed schemas 에 admin 을 넣지 마세요.
-- * 보기는 security_invoker 라서 읽는 사람의 권한으로 돌아요(postgres 는 다 읽을 수 있어요).
-- * 날짜는 모두 한국 날짜·시각(Asia/Seoul)이에요. 이름이 _kst 로 끝나는 열은 시간대 없는 한국 시각이에요.
-- * profiles.is_internal = true 인 계정(Seo 본인)은 testers·daily·funnel 에서 빼요.
--   recent_events·push_log 는 내 기록이 잘 들어오는지 확인할 수 있게 그대로 두고 internal 열로 표시해요.
--
-- 예: select * from admin.testers;

begin;

create schema if not exists admin;
comment on schema admin is 'Seo 전용 요약 보기. Data API 에 노출하지 않아요.';

-- 테스터 한 명당 한 줄
drop view if exists admin.testers;
create view admin.testers with (security_invoker = true) as
with ev as (
  select
    e.user_id,
    min(e.client_at) as first_at,
    max(e.client_at) as last_at,
    count(distinct (e.client_at at time zone 'Asia/Seoul')::date) as active_days,
    count(*) filter (where e.client_at >= now() - interval '7 days') as events_7d,
    count(distinct e.device_id) as devices,
    bool_or(e.display_mode = 'standalone') as home_screen_app,
    bool_or(e.in_app is not null) as opened_in_app_browser
  from public.events e
  group by e.user_id
),
last_client as (
  select distinct on (e.user_id) e.user_id, e.os, e.browser, e.in_app
  from public.events e
  order by e.user_id, e.client_at desc
),
sv as (
  select
    s.user_id,
    count(*) as saves,
    count(*) filter (where cardinality(coalesce(s.alert_presets, p.default_alerts)) > 0) as alerts_on
  from public.saves s
  join public.profiles p on p.user_id = s.user_id
  group by s.user_id
),
it as (
  select
    i.user_id,
    count(*) filter (where i.interest_id like 'entity:%') as follows_entity,
    count(*) filter (where i.interest_id like 'category:%') as follows_category
  from public.interests i
  group by i.user_id
),
ps as (
  select ps.user_id, count(*) as push_devices
  from public.push_subscriptions ps
  where ps.disabled_at is null
  group by ps.user_id
)
select
  case when u.is_anonymous then '익명 · ' || left(p.user_id::text, 8) else coalesce(u.email, '(이메일 없음)') end as tester,
  (ev.first_at at time zone 'Asia/Seoul') as first_seen_kst,
  (ev.last_at at time zone 'Asia/Seoul') as last_seen_kst,
  coalesce(ev.active_days, 0) as active_days,
  coalesce(ev.events_7d, 0) as events_7d,
  coalesce(sv.saves, 0) as saves,
  coalesce(it.follows_entity, 0) as follows_entity,
  coalesce(it.follows_category, 0) as follows_category,
  coalesce(sv.alerts_on, 0) as alerts_on,
  array_to_string(p.default_alerts, ', ') as default_alerts,
  coalesce(ps.push_devices, 0) as push_devices,
  coalesce(ev.home_screen_app, false) as home_screen_app,
  coalesce(ev.devices, 0) as devices,
  lc.os as last_os,
  lc.browser as last_browser,
  coalesce(ev.opened_in_app_browser, false) as opened_in_app_browser,
  (p.created_at at time zone 'Asia/Seoul') as account_created_kst,
  p.user_id
from public.profiles p
join auth.users u on u.id = p.user_id
left join ev on ev.user_id = p.user_id
left join last_client lc on lc.user_id = p.user_id
left join sv on sv.user_id = p.user_id
left join it on it.user_id = p.user_id
left join ps on ps.user_id = p.user_id
where not p.is_internal
  -- 기록이 하나도 없는 익명 계정(초기화하고 남은 옛 계정 등)은 뺀다
  and (u.is_anonymous is not true or ev.user_id is not null)
order by ev.last_at desc nulls last;

comment on view admin.testers is '테스터 한 명당 한 줄: 처음·마지막 방문, 방문한 날 수, 최근 7일 이벤트, 담기·팔로우·알림·푸시, 홈 화면 앱 여부. Seo 본인(is_internal) 제외.';

-- 날짜별(한국 날짜) 방문자·이벤트·새 담기·보낸 푸시·눌린 푸시
drop view if exists admin.daily;
create view admin.daily with (security_invoker = true) as
with internal as (
  select p.user_id from public.profiles p where p.is_internal
),
ev as (
  select
    (e.client_at at time zone 'Asia/Seoul')::date as day_kst,
    count(distinct e.user_id) as visitors,
    count(*) as events,
    count(*) filter (where e.name = 'push_opened') as push_opened
  from public.events e
  where not exists (select 1 from internal x where x.user_id = e.user_id)
  group by 1
),
sv as (
  select (s.created_at at time zone 'Asia/Seoul')::date as day_kst, count(*) as new_saves
  from public.saves s
  where not exists (select 1 from internal x where x.user_id = s.user_id)
  group by 1
),
pd as (
  select
    (d.created_at at time zone 'Asia/Seoul')::date as day_kst,
    count(*) filter (where d.status in ('sent', 'partial')) as push_sent
  from public.push_deliveries d
  where d.kind <> 'test'
    and not exists (select 1 from internal x where x.user_id = d.user_id)
  group by 1
)
select
  day_kst,
  coalesce(ev.visitors, 0) as visitors,
  coalesce(ev.events, 0) as events,
  coalesce(sv.new_saves, 0) as new_saves,
  coalesce(pd.push_sent, 0) as push_sent,
  coalesce(ev.push_opened, 0) as push_opened
from ev
full join sv using (day_kst)
full join pd using (day_kst)
order by day_kst desc;

comment on view admin.daily is '한국 날짜별 방문자 수, 이벤트 수, 새 담기, 보낸 푸시(테스트 제외), 눌린 푸시. Seo 본인 제외.';

-- 방문 → 관심사 고름 → 첫 담기 → 로그인 → 알림 허용 → 푸시 눌러 들어옴, 단계별 인원(각 단계에 닿은 사람 수)
drop view if exists admin.funnel;
create view admin.funnel with (security_invoker = true) as
with people as (
  select p.user_id, u.is_anonymous, p.onboarding_complete
  from public.profiles p
  join auth.users u on u.id = p.user_id
  where not p.is_internal
),
flags as (
  select
    pe.user_id,
    exists (select 1 from public.events e where e.user_id = pe.user_id) as visited,
    (
      pe.onboarding_complete
      or exists (select 1 from public.interests i where i.user_id = pe.user_id)
      or exists (
        select 1 from public.events e
        where e.user_id = pe.user_id
          and (e.name = 'category_followed' or (e.name = 'entity_followed' and e.properties ->> 'followed' = 'true'))
      )
    ) as picked_interest,
    (
      exists (select 1 from public.saves s where s.user_id = pe.user_id)
      or exists (select 1 from public.events e where e.user_id = pe.user_id and e.name = 'add_to_trove')
    ) as saved,
    (
      pe.is_anonymous is false
      or exists (select 1 from public.events e where e.user_id = pe.user_id and e.name in ('signup_completed', 'login_completed'))
    ) as logged_in,
    (
      exists (select 1 from public.push_subscriptions ps where ps.user_id = pe.user_id)
      or exists (
        select 1 from public.events e
        where e.user_id = pe.user_id and e.name in ('notification_permission_granted', 'push_subscribed')
      )
    ) as allowed_push,
    exists (select 1 from public.events e where e.user_id = pe.user_id and e.name = 'push_opened') as opened_push
  from people pe
),
steps as (
  select 1 as step, '방문' as label, count(*) filter (where visited) as users from flags
  union all select 2, '관심사 고름', count(*) filter (where visited and picked_interest) from flags
  union all select 3, '첫 담기', count(*) filter (where visited and saved) from flags
  union all select 4, '로그인', count(*) filter (where visited and logged_in) from flags
  union all select 5, '알림 허용', count(*) filter (where visited and allowed_push) from flags
  union all select 6, '푸시 눌러 들어옴', count(*) filter (where visited and opened_push) from flags
)
select
  s.step,
  s.label,
  s.users,
  round(100.0 * s.users / nullif((select v.users from steps v where v.step = 1), 0), 1) as pct_of_visitors
from steps s
order by s.step;

comment on view admin.funnel is '방문 → 관심사 고름 → 첫 담기 → 로그인 → 알림 허용 → 푸시 눌러 들어옴. 각 단계에 닿은 방문자 수와 방문자 대비 %. Seo 본인 제외.';

-- 최근 이벤트 500개(누가 했는지와 함께)
drop view if exists admin.recent_events;
create view admin.recent_events with (security_invoker = true) as
select
  (e.client_at at time zone 'Asia/Seoul') as at_kst,
  case when u.is_anonymous then '익명 · ' || left(e.user_id::text, 8) else coalesce(u.email, '(이메일 없음)') end as tester,
  e.name,
  e.properties,
  e.path,
  e.display_mode,
  e.os,
  e.browser,
  e.in_app,
  e.app_version,
  left(e.device_id, 8) as device,
  left(e.session_id, 8) as session,
  coalesce(p.is_internal, false) as internal,
  (e.received_at at time zone 'Asia/Seoul') as received_kst,
  e.user_id
from public.events e
left join auth.users u on u.id = e.user_id
left join public.profiles p on p.user_id = e.user_id
order by e.client_at desc, e.id desc
limit 500;

comment on view admin.recent_events is '최근 이벤트 500개. internal = Seo 본인 기록.';

-- 누구에게 어떤 알림이 언제 갔고 실패했는지(PR5 부터)
drop view if exists admin.push_log;
create view admin.push_log with (security_invoker = true) as
select
  (d.created_at at time zone 'Asia/Seoul') as created_kst,
  case when u.is_anonymous then '익명 · ' || left(d.user_id::text, 8) else coalesce(u.email, '(이메일 없음)') end as tester,
  d.release_id,
  d.kind,
  d.due_date,
  (d.slot_at at time zone 'Asia/Seoul') as slot_kst,
  d.status,
  d.sent_count,
  d.error,
  coalesce(p.is_internal, false) as internal,
  d.user_id
from public.push_deliveries d
left join auth.users u on u.id = d.user_id
left join public.profiles p on p.user_id = d.user_id
order by d.created_at desc, d.id desc;

comment on view admin.push_log is '알림 발송 기록(PR5 부터). internal = Seo 본인.';

-- 앱(anon·authenticated)은 admin 을 볼 수 없다
revoke all on schema admin from public, anon, authenticated;
revoke all on all tables in schema admin from public, anon, authenticated;

commit;
