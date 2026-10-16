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

운영 콘솔에서 **발행**만 하면, 맥에 등록해 둔 작업이 10분 안에 `public/releases.json` 을 갱신해 커밋·푸시하고, Vercel 이 1~2분 뒤 새 데이터를 배포합니다. 사람이 `data:pull` 을 돌리거나 커밋할 필요가 없습니다.

한 번만 등록합니다(앱 폴더에서):

```bash
npm run data:push:install
```

잘 돌고 있는지 보려면:

```bash
npm run data:push:status                        # 등록 여부, 마지막 실행 결과, 최근 로그 5줄
tail -n 20 ~/Library/Logs/trove-data-push.log   # 로그 전체
```

지금 바로 한 번 반영하고 싶을 때(등록과 상관없이 아무 때나 실행할 수 있습니다):

```bash
npm run data:push               # 변경이 있으면 커밋·푸시, 없으면 "변경 없음"
npm run data:push -- --wait     # 푸시 뒤 Vercel 배포가 끝날 때까지 최대 5분 기다립니다
npm run data:push -- --dry-run  # 무엇을 할지만 보여 주고 실제로는 바꾸지 않습니다
```

멈추려면:

```bash
npm run data:push:uninstall
```

전제 조건은 두 가지입니다.

- 앱 폴더가 `main` 브랜치에 있어야 합니다. 다른 브랜치에 있으면 아무것도 하지 않고 로그에 그 이유를 남깁니다.
- 맥에서 `git push` 가 로그인(비밀번호·토큰 입력) 없이 되어야 합니다. 원격 주소는 HTTPS(`https://github.com/…`)로 두고 macOS 키체인에 GitHub 로그인을 저장해 두는 것을 권장합니다(`git config --global credential.helper osxkeychain`). ssh(`git@github.com:…`) 주소는 자동 실행 환경에 ssh 에이전트가 없어 실패할 수 있습니다.

안전장치: 발행물이 0건이거나 이전보다 절반 넘게 줄어들면 반영하지 않고 로그에 남깁니다(정말 의도한 경우 `npm run data:push -- --allow-empty` 또는 `-- --allow-shrink`). 커밋에는 `public/releases.json` 과 `public/releases.meta.json` 두 파일만 들어가며, 앱 폴더의 다른 수정 사항은 건드리지 않습니다. 로컬에 직접 만든 미푸시 커밋이 있으면 그것을 먼저 푸시하라고 알리고 멈춥니다. 주기는 `TROVE_PUSH_INTERVAL=300 npm run data:push:install` 처럼 초 단위로 바꿀 수 있고, 발행물 폴더가 기본 위치(`trove-ops/data`)가 아니면 `TROVE_OPS_DATA_DIR=/path npm run data:push:install` 로 함께 넣습니다.

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
- 행동 이벤트를 브라우저에 기록하는 MVP 분석 계층
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

회원 인증과 상태 저장은 제품 흐름 검증을 위한 브라우저 로컬 구현입니다. 실제 Supabase Auth/DB, 헤르메스 XLSX → staging → 관리자 승인 콘솔, 푸시 구독 키와 예약 발송, 결제는 서버 자격증명과 관리자 권한 정책을 연결한 뒤 추가해야 합니다. 공개 배포에서 URL만 숨긴 운영 콘솔은 보안 기능이 아니므로 현재 버전에는 포함하지 않았습니다.
# trove
