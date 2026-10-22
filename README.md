# Trove

영화, 게임, 음악, 스니커즈와 라이프스타일 드롭처럼 기다리는 출시일을 한곳에 모으는 모바일 우선 웹 MVP입니다. 제공된 Figma의 네 화면을 기반으로 `발견 → 상세 → Trove 저장 → 로그인 → 알림 설정 → 다시 확인`의 전체 제품 플로우를 연결했습니다.

## 실행

```bash
npm install
npm run dev
```

기본 개발 주소는 `http://127.0.0.1:4173`입니다.

```bash
npm run check
npm run build
```

## 데이터

앱은 목업 데이터를 쓰지 않고, 운영 콘솔(`trove-ops`)이 **승인된 일정만** 모아 발행한 `releases.json` 을 읽습니다.

- 앱이 시작할 때 같은 사이트의 `/releases.json`(과 `/releases.meta.json`)을 한 번 내려받아 모든 화면이 공유합니다.
- 개발 서버(`npm run dev`)는 `trove-ops/data`(또는 `TROVE_OPS_DATA_DIR`)의 발행물을 바로 읽습니다. 콘솔에서 발행한 뒤 브라우저를 새로고침하면 됩니다.
- 배포용 빌드와 커밋에는 아래처럼 `public/` 로 복사한 사본이 필요합니다.

```bash
npm run data:pull            # ./trove-ops/data → public/
TROVE_OPS_DATA_DIR=/path/to/data npm run data:pull
```

- 가져온 `public/releases.json` 을 커밋해 푸시하면 Vercel 이 그대로 서빙합니다. 복사·커밋·푸시를 한 번에 하려면 `npm run data:push`, 맥에서 자동으로 돌리려면 아래 "발행 자동 반영" 을 보세요. 파일이 없으면 앱은 "출시 일정을 불러오지 못했어요" 화면을 보여 줍니다.
- 다른 주소의 발행물을 읽게 하려면 `VITE_RELEASES_URL`(과 `VITE_RELEASES_META_URL`) 환경 변수를 빌드 시점에 넣습니다. 다른 도메인이면 그쪽 서버가 CORS(`Access-Control-Allow-Origin`)를 허용해야 합니다.
- `npm run build` 는 `public/releases.json` 이 없으면(그리고 `VITE_RELEASES_URL` 도 없으면) 멈춥니다. 발행 파일 없이 배포되는 일을 막기 위해서입니다.
- 발행물 → 앱 변환 규칙은 `src/data/published.ts` 에 있습니다. 날짜는 `YYYY-MM-DD` 만 쓰고(시각은 공연 티켓오픈에만), 기간형 일정은 "2026년 11월" 같은 말로 바꾸며, 이미지가 없는 항목은 아티스트·브랜드 첫 글자로 그린 타일을 씁니다. 관심사 목록은 카테고리 다섯 개와 발행물 속 아티스트·브랜드에서 만듭니다.

### 발행 자동 반영 (Mac)

운영 콘솔에서 **발행**만 하면, 맥에 등록해 둔 작업이 10분 안에 `public/releases.json` 을 갱신해 커밋·푸시하고, Vercel 이 1~2분 뒤 새 데이터를 배포합니다. 사람이 `data:pull` 을 돌리거나 커밋할 필요가 없습니다. 단, 맥이 켜져 있고 로그인돼 있을 때만 돕니다. 잠자기(덮개를 닫은) 중에는 돌지 않고, 깨어나면 다음 주기에 반영됩니다.

한 번만 등록합니다(앱 폴더에서, ssh 가 아니라 맥 화면에 로그인한 그 세션의 터미널에서):

```bash
npm run data:push:install
```

macOS 13 이상에서는 등록 직후 "백그라운드 항목 추가됨" 알림이 뜨고, 시스템 설정 > 일반 > 로그인 항목 > 백그라운드에서 허용 목록에 `node` 로 보입니다. 이 스위치를 끄면 자동 반영이 멈추니 켜 두세요. 끈 적이 있으면 `npm run data:push:install` 을 다시 실행하면 됩니다(등록할 때 `launchctl enable` 을 함께 수행합니다).

잘 돌고 있는지 보려면:

```bash
npm run data:push:status                        # 등록 여부, 마지막 실행 결과, 최근 로그 5줄
tail -n 20 ~/Library/Logs/trove-data-push.log   # 최근 로그 20줄
```

로그는 계속 덧붙여지고 자동으로 비워지지 않습니다(10분 주기면 하루 5KB 안팎). 커지면 그냥 지워도 됩니다. Node 를 다른 위치로 옮기거나 버전 관리 도구로 바꿨다면(`nvm` 기본 버전 변경 등) 등록된 작업이 설치 당시의 node 경로를 쓰므로 `npm run data:push:install` 을 한 번 더 실행하세요. `npm run data:push:status` 가 "노드 경로가 없어요" 라고 알려 줍니다(Homebrew 의 node 는 `brew upgrade` 뒤에도 그대로인 경로로 등록합니다).

지금 바로 한 번 반영하고 싶을 때(등록과 상관없이 아무 때나 실행할 수 있습니다):

```bash
npm run data:push               # 변경이 있으면 커밋·푸시, 없으면 "변경 없음"
npm run data:push -- --wait     # 푸시 뒤 Vercel 배포가 끝날 때까지 최대 5분 기다립니다
npm run data:push -- --dry-run  # 무엇을 할지만 보여 주고 아무것도 바꾸지 않습니다(원격 상태만 읽어 옵니다)
```

`--wait` 는 GitHub 의 공개 REST API(인증 없음, IP 당 시간당 60회) 로 배포 상태를 읽습니다. 저장소를 비공개로 바꾸거나 한 시간에 여러 번 쓰면 상태를 읽지 못할 수 있는데, 그래도 푸시는 된 것이니 Vercel 대시보드에서 확인하면 됩니다.

멈추려면:

```bash
npm run data:push:uninstall
```

전제 조건은 네 가지입니다.

- 앱 폴더가 `main` 브랜치에 있어야 합니다. 다른 브랜치에 있으면 아무것도 하지 않고 로그에 그 이유를 남깁니다.
- 맥에서 `git push` 가 로그인(비밀번호·토큰 입력) 없이 되어야 합니다. 자동 실행(launchd) 중에는 git 이 토큰이나 ssh 키 암호를 물을 수 없습니다. HTTPS 주소(`https://github.com/…`)면 macOS 키체인에 GitHub 로그인을 한 번 저장해 두고(`git config --global credential.helper osxkeychain` 뒤 터미널에서 한 번 푸시), ssh(`git@github.com:…`) 주소면 키 암호를 키체인에 넣어 두세요(`ssh-add --apple-use-keychain ~/.ssh/<키>`, `~/.ssh/config` 에 `UseKeychain yes`). `npm run data:push:install` 과 `status` 가 이 조건 그대로 인증을 미리 확인해 알려 줍니다. 로그인 정보가 없어 푸시가 거절되면 스크립트는 재시도하지 않고 로그에 "로그인할 수 없어서" 와 할 일을 남깁니다.
- 맥에 그 계정으로 **화면 로그인이 되어 있고, 맥이 잠들지 않아야** 합니다. 등록된 작업은 로그인한 사용자 세션(launchd `gui/<uid>`) 안에서만 돌기 때문에, 재시작 뒤 로그인하기 전이나 맥이 잠자는 동안에는 돌지 않습니다(깨어나면 다음 주기에 이어서 돕니다). 계속 돌리려면 시스템 설정 → 사용자 및 그룹에서 자동 로그인을 켜고(FileVault 가 켜져 있으면 재시작 뒤 잠금 해제 화면에서 한 번 로그인해야 합니다), 에너지(디스플레이) 설정에서 "디스플레이가 꺼져 있을 때 자동으로 잠자기 방지" 를 켭니다. ssh 로 접속한 터미널에서 `npm run data:push:install` 을 실행하면 "이 계정으로 맥 화면에 로그인한 세션(GUI)이 없어요" 라며 멈춥니다.
- 앱 폴더가 `~/Documents`, `~/Desktop`, `~/Downloads` 안에 있으면(예: `~/Documents/Trove`), 등록 직후 첫 자동 실행 때 macOS 가 "node"이(가) Documents 폴더의 파일에 접근하려고 합니다 라는 창을 띄웁니다. 반드시 **허용**을 누르세요. 거부했거나 나중에 로그에 `EPERM: operation not permitted, open '…/scripts/push-releases.mjs'` 가 보이면 시스템 설정 > 개인정보 보호 및 보안 > 파일 및 폴더 에서 node 의 "Documents 폴더" 를 켜 주세요. 터미널에서 직접 `npm run data:push` 를 돌릴 때는 터미널의 권한을 물려받아 이 창이 뜨지 않습니다. node 를 업데이트하면(예: `brew upgrade node`) 다시 물어볼 수 있습니다. 앱 폴더를 세 폴더 밖(예: `~/Projects/Trove`)에 두면 이 절차가 필요 없습니다(`install` 과 `status` 가 보호 폴더 안이면 미리 알려 줍니다).

안전장치: 발행물이 0건이거나 마지막으로 커밋된 것보다 절반 넘게 줄어들면 반영하지 않고 로그에 남깁니다(정말 의도한 경우 `npm run data:push -- --allow-empty` 또는 `-- --allow-shrink`). 커밋에는 `public/releases.json` 과 `public/releases.meta.json` 두 파일만 들어가며, 앱 폴더의 다른 수정 사항은 건드리지 않습니다(이 두 파일에 커밋되지 않은 변경이 남아 있으면 발행물로 덮어쓰기 전에 되돌립니다). 로컬에 직접 만든 미푸시 커밋이 있으면 그것을 먼저 푸시하라고 알리고 멈춥니다. 지난 실행이 푸시하지 못한 발행 커밋만 남아 있을 때 원격이 앞서 나가 있으면, 그 커밋을 원격 위로 올려 다시 푸시합니다. 주기는 `TROVE_PUSH_INTERVAL=300 npm run data:push:install` 처럼 초 단위로 바꿀 수 있고, 발행물 폴더가 기본 위치(`trove-ops/data`)가 아니면 `TROVE_OPS_DATA_DIR=/path npm run data:push:install` 로 함께 넣습니다. 원격 이름이 `origin` 이 아니거나 브랜치가 `main` 이 아니면 `TROVE_PUSH_REMOTE=…`, `TROVE_PUSH_BRANCH=…` 도 같은 방식으로 함께 넣습니다.

## 서버 (Supabase) — 1단계: 사용 기록

이번 단계에서 서버로 가는 것은 **앱 안 사용 기록(`track()` 이벤트)뿐**입니다. 관심사·담은 기다림·알림 설정·데모 로그인은 지금처럼 이 브라우저의 localStorage 에만 있습니다. 앱을 처음 열면 화면에 아무것도 띄우지 않고 Supabase 익명 계정을 하나 만들고, 사용 기록은 그 계정에 묶여 `public.events` 에 쌓입니다.

### Seo 가 할 일 (한 번)

1. Supabase → New project: 이름 `trove`, 리전 **Seoul (ap-northeast-2)**. DB 비밀번호는 비밀번호 관리자에만 저장합니다.
2. Authentication → Sign In / Providers → **Anonymous sign-ins** 를 켭니다. (Email·Manual linking 은 2단계 로그인 때 켭니다.)
3. SQL Editor → New query 에 `supabase/migrations/0001_init.sql` 내용을 통째로 붙여 **Run**, 이어서 `supabase/admin-views.sql` 도 같은 방법으로 **Run**. 두 파일 모두 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않고, 다시 실행해도 안전합니다(쌓인 데이터는 그대로). SQL 은 코드라 붙여도 괜찮습니다. 키가 아닙니다.
   - **Run** 을 누르면 두 파일 모두 "Potential issue detected" 창이 뜹니다(destructive operations: 데이터나 객체를 지우거나 바꿀 수 있다는 경고). 다시 실행해도 안전하도록 넣은 `drop … if exists` 와 `delete_my_data()` 함수 안의 `delete` 때문이라 정상입니다. 붙인 내용이 이 저장소의 그 파일이 맞는지 확인하고 **Run query** 를 누릅니다.
4. Project Settings → API Keys 의 **Publishable key**(`sb_publishable_…`)와 Project Settings → Data API 의 Project URL(`https://<ref>.supabase.co`)을 복사해 Vercel → Settings → Environment Variables 에 넣습니다. Environments 는 **Production 과 Preview** 둘 다 고릅니다.
   - `VITE_SUPABASE_URL` = Project URL
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = Publishable key
5. 환경 변수는 빌드 때 앱에 들어가므로 새로 빌드해야 반영됩니다. 맨 위 배포가 아니라 **1단계 PR 의 미리보기**를 다시 빌드합니다: Vercel → Deployments 에서 Branch 가 `claude/server-events` 인 가장 최근 배포의 ⋯ → **Redeploy**(맨 위 줄은 매일 올라가는 `main` 발행 배포일 때가 많고, `main` 에는 아직 서버 코드가 없어 다시 빌드해도 바뀌지 않습니다). 미리보기에서 확인하고 `main` 에 합치면 Production 은 새 환경 변수로 자동 배포됩니다. 합친 뒤에 값을 바꿨다면 Production(Current) 배포를 Redeploy 합니다. 앱 버전(`app_version`)은 Vercel 이 주는 커밋 앞 7자리가 자동으로 붙습니다.
6. Advisors → Security Advisor 에서 빨간(ERROR) 경고가 없는지 봅니다. 노란 경고 중 "익명 사용자에게도 적용되는 정책(anonymous access)" 과 "로그인 사용자가 security definer 함수(`delete_my_data`, `register_push_subscription`)를 실행할 수 있음" 은 의도한 것입니다.

키 다루기:

- 키는 채팅·이슈·커밋에 붙이지 않고 Vercel 화면에 직접 넣습니다. Publishable key 는 앱에 그대로 실리는 공개용이지만 습관으로 지킵니다.
- **Secret key(`sb_secret_…`)·service_role 키는 앱 어디에도 넣지 않습니다.** 특히 `VITE_` 로 시작하는 이름에 넣으면 빌드 결과에 그대로 박혀 누구나 봅니다. 새어 나갔다고 생각되면 API Keys 에서 새로 만들고 옛 키를 끕니다.
- Project Settings → Data API → Exposed schemas 에 `admin` 을 넣지 않습니다. 요약 보기는 대시보드에서만 봅니다.

### 데이터 보는 곳

- **Table Editor**: `events`(사용 기록 원본), `profiles` 등 원본 표.
- **SQL Editor**: `select * from admin.testers;` 처럼 실행합니다. 자주 쓰는 것은 Save 해 두면 다음부터 한 번에 열립니다.
  - `admin.testers` 테스터 한 명당 한 줄(처음·마지막 방문, 방문한 날 수, 최근 7일 이벤트, 담기·팔로우·알림 수, 홈 화면 앱 여부, 운영체제·브라우저, 앱 안 브라우저로 연 적 있는지). 기록이 하나도 없는 익명 계정(초기화 직후 등)은 뺍니다.
  - `admin.daily` 한국 날짜별 방문자·이벤트·새 담기 수(푸시 열은 푸시를 붙인 뒤부터 채워집니다)
  - `admin.funnel` 방문 → 관심사 고름 → 첫 담기 → 로그인 → 알림 허용 → 푸시 눌러 들어옴, 단계별 인원
  - **1단계에서는 담기·팔로우·알림 열이 비어 있습니다.** `testers` 의 담기·팔로우·알림 수(0)와 기본 알림(`D-1, D-Day`), `daily` 의 새 담기 수(0)는 3단계(동기화)부터 채워집니다. 그 전에는 `funnel` 이나 `recent_events` 의 `add_to_trove`·`entity_followed`·`category_followed` 로 보세요. `funnel` 의 "관심사 고름" 도 그 전에는 홈·아티스트 화면의 팔로우만 잡혀(처음 관심사 고르는 화면은 기록이 없습니다) 적게 나오고, "첫 담기" 보다 작을 수 있습니다.
  - `admin.recent_events` 최근 이벤트 500개, `admin.push_log` 푸시 기록(푸시를 붙인 뒤부터)
- **본인 기기 빼기**: 본인 기기에서 발견 탭에 남이 칠 리 없는 검색어(예: `seo-내기기`)를 한 번 넣고, 몇 초 뒤 SQL Editor 에서 실행합니다.

  ```sql
  update public.profiles set is_internal = true
  where user_id in (select user_id from public.events
                    where name = 'discover_search' and properties->>'query' = 'seo-내기기');
  ```

  임시 계정은 브라우저마다 따로 생깁니다. 같은 아이폰이라도 Safari, 홈 화면 앱, 카카오톡 안 브라우저는 각각 다른 계정이므로 **브라우저·홈 화면 앱마다 한 번씩** 하고, 거기서 MVP 데이터 초기화를 하면 새 임시 계정이 생기므로 다시 합니다. `testers`·`daily`·`funnel` 에서 빠지고, `recent_events`·`push_log` 에는 `internal` 열로 표시됩니다.
- 무료 플랜은 자동 백업이 없습니다. 테스트 중에는 주 1회 `admin.testers` 와 `events` 를 CSV 로 받아 둡니다(Table Editor › Export, 또는 SQL Editor 결과의 Export).

### 서버 없이 돌 때 (로컬 전용)

`VITE_SUPABASE_URL` 이나 `VITE_SUPABASE_PUBLISHABLE_KEY` 가 하나라도 비어 있으면(로컬 `npm run dev` 기본값, 환경 변수를 안 넣은 배포) 앱은 서버를 전혀 부르지 않습니다. Supabase 코드는 따로 떨어진 조각이라 내려받지도 않고, 사용 기록은 예전처럼 브라우저의 `trove-analytics-v1` 에 최근 200개만 남습니다. 서버가 켜진 빌드를 처음 열면 이 기록을 한 번만 서버로 옮기고(`properties.migrated = true`) 지웁니다. 로컬에서 서버까지 붙여 보려면 두 값을 `.env.local`(커밋되지 않음)에 넣습니다.

동작 요약:

- `src/lib/supabase.ts` 클라이언트(필요할 때만 불러옴)와 익명 세션. 세션이 없을 때만, 여러 탭·새로고침에서도 한 번만 만들고, 화면을 막지 않으며, 실패하면 조금 뒤 다시 합니다.
- `src/lib/analytics-core.ts` 묶음 전송(3초 모아서, 또는 화면이 숨겨지거나 닫힐 때 keepalive), 재시도 큐(localStorage `trove-events-queue-v1`, 최대 500개, 넘치면 오래된 것부터 버림. 같은 브라우저의 탭들이 함께 쓰고, 각 탭은 제가 넣은 기록을 서버가 받을 때까지 메모리에도 들고 있어 다른 탭이 큐를 덮어써도 되살려 보냄), 공통 필드(기기 ID, 30분 쉬면 바뀌는 방문 ID, 경로, 홈 화면 앱 여부, 앱 버전, 브라우저 요약), 검색어 앞 100자만 보냄, 같은 기록이 두 번 들어가지 않게 `client_event_id`.
- 프로필 → MVP 데이터 초기화: 서버의 `delete_my_data()` 로 지금 이 브라우저(또는 홈 화면 앱)의 임시 계정 기록을 지우고 로그아웃한 뒤, 다음 기록 때 새 임시 계정을 만듭니다. Safari·홈 화면 앱·카카오톡 안 브라우저의 기록은 각각에서 초기화해야 지워집니다. 인터넷이 안 되면 다음에 앱을 열 때 마저 지우고, 그동안 새 기록은 보내지 않고 모아 둡니다.
- Supabase 로그에 가끔 보이는 `409`(duplicate key, `events_user_client_event_key`)는 정상입니다. 창을 닫을 때 keepalive 로 보낸 기록은 도착했는지 알 수 없어 다음에 한 번 더 보내고, 이미 있으면 서버가 409 로 거절합니다.

### 시험

- `npm test` 앱 시험과 분석 로직 시험(가짜 시계·가짜 서버, 네트워크 없음).
- `npm run test:db` 임시 PostgreSQL(15 이상) 을 띄워 Supabase 흉내(`auth` 스키마, `anon`·`authenticated`·`service_role` 역할) 위에 두 SQL 을 돌리고 보안 규칙을 확인합니다. 남의 행은 못 보고·못 고치고·못 지움, `events` 는 넣기만 되고 `user_id` 를 속일 수 없음, 로그인 전(anon)은 아무것도 못 함, `is_internal` 은 앱에서 못 바꿈, `delete_my_data` 는 내 것만, `admin` 은 앱에서 안 보임 등. Supabase 의 예전 자동 권한 방식과 새 방식으로 두 번 돕니다. `npm test`·Vercel 빌드에는 들어가지 않고, PostgreSQL 이 없으면 이유를 말하고 건너뜁니다.
  - 맥: `brew install postgresql@16` 뒤 `PG_BIN=$(brew --prefix postgresql@16)/bin npm run test:db`
  - root 로 돌리면 서버는 `PG_RUN_AS`(기본 `postgres`) 사용자로 띄웁니다.
- `npm run smoke` Playwright(Chromium)로 실제 빌드를 띄워 봅니다. 실제 Supabase 에는 접속하지 않습니다. (a) 환경 변수 없이: 홈이 뜨고 다른 주소로는 요청이 하나도 없음 (b) 가짜 Supabase 서버(`scripts/smoke/mock-supabase.mjs`)를 향하게: 익명 가입은 한 번, 묶음 전송과 공통 필드, 500 뒤 재전송, 탭 닫을 때 keepalive, 초기화, 두 탭이 500 중에 동시에 숨겨져도 기록이 모두 한 번씩 도착 (c) 개발 서버(StrictMode)에서도 가입 한 번. Playwright 는 이 저장소 의존성이 아니라서 `npm i -g playwright && npx playwright install chromium` 처럼 전역에 깔아 두거나 `PLAYWRIGHT_MODULE=<playwright 폴더>` 로 위치를 알려 줍니다.

## 구현된 흐름

- 관심사 검색·선택 및 선택값 저장
- 내 다음 출시와 관심사 우선순위를 반영한 Home
- 검색·카테고리·기간·정렬을 제공하는 Discover
- 날짜 그룹별 저장 목록과 알림 상태를 보여주는 Trove
- 월/주 캘린더, 날짜 선택, 일정 목록
- 상세 이미지 캐러셀, 소개, 출처, 마지막 확인 일시, 관련 콘텐츠
- Trove 저장과 알림 설정을 분리한 UX
- 비회원 저장 시 로그인 후 원래 행동을 자동으로 복원하는 맥락형 인증
- D-7, D-1, 당일 및 출시일 확정·변경 알림 프리셋
- 관심사·기본 알림·브라우저 알림·계정을 관리하는 Profile
- 기본 서비스 워커와 웹푸시 수신 진입점
- 행동 이벤트를 묶어 Supabase 에 보내는 분석 계층(환경 변수가 없으면 브라우저에만 기록)
- 새로고침 후에도 유지되는 버전 관리형 로컬 상태
- 360×780 모바일 레이아웃과 430px 데스크톱 앱 셸

## 주요 경로

- `/home`
- `/discover`
- `/trove`
- `/trove/calendar`
- `/profile`
- `/preferences`
- `/release/:slug`

## 데이터 연결 지점

출시 데이터는 위 `데이터` 절대로 `public/releases.json`(운영 콘솔 발행물) 에서 오고, 앱 쪽 변환 규칙은 `src/data/published.ts` 에 있습니다. 날짜 확정 콘텐츠뿐 아니라 날짜 미정·예정 시기, 상태, 출처, 마지막 확인 일시를 표현할 수 있습니다.

회원 인증과 상태 저장은 제품 흐름 검증을 위한 브라우저 로컬 구현입니다(서버로 가는 것은 위 "서버 (Supabase) — 1단계" 의 사용 기록뿐). 이메일 로그인과 상태 동기화(Supabase Auth/DB), 헤르메스 XLSX → staging → 관리자 승인 콘솔, 푸시 구독 키와 예약 발송, 결제는 서버 자격증명과 관리자 권한 정책을 연결한 뒤 추가해야 합니다. 공개 배포에서 URL만 숨긴 운영 콘솔은 보안 기능이 아니므로 현재 버전에는 포함하지 않았습니다.
# trove
