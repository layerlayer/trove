/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 발행물 주소를 바꿀 때만. 기본은 같은 사이트의 /releases.json */
  readonly VITE_RELEASES_URL?: string;
  readonly VITE_RELEASES_META_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
