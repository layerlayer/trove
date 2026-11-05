/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 발행물 주소를 바꿀 때만. 기본은 같은 사이트의 /releases.json */
  readonly VITE_RELEASES_URL?: string;
  readonly VITE_RELEASES_META_URL?: string;
  /** Trove 서버(Supabase) 주소 `https://<ref>.supabase.co`. 키와 둘 다 있을 때만 서버 모드 */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable 키 `sb_publishable_…`(공개돼도 되는 키). 비밀 키(sb_secret_…)는 절대 넣지 않는다 */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

/** 빌드한 커밋(Vercel 의 VERCEL_GIT_COMMIT_SHA 앞 7자리). 로컬 빌드는 "dev". vite.config.ts 의 define */
declare const __APP_VERSION__: string;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
