import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Interest, ReleaseItem } from "../types";
import { adaptReleases, deriveInterests, type PublishedMeta } from "./published";

/** 발행물 주소. 기본은 같은 사이트의 /releases.json (운영 콘솔이 만든 파일을 public/ 에 복사해 둔다) */
const RELEASES_URL = import.meta.env.VITE_RELEASES_URL?.trim() || `${import.meta.env.BASE_URL}releases.json`;
const META_URL = import.meta.env.VITE_RELEASES_META_URL?.trim() || `${import.meta.env.BASE_URL}releases.meta.json`;

export type ReleaseDataStatus = "loading" | "ready" | "error";

export interface ReleaseData {
  status: ReleaseDataStatus;
  releases: ReleaseItem[];
  interests: Interest[];
  /** 콘솔이 발행한 시각(ISO). releases.meta.json 이 없으면 null */
  publishedAt: string | null;
  /** 모양이 맞지 않아 건너뛴 건수 */
  skipped: number;
  error: string | null;
  reload: () => void;
}

const ReleaseDataContext = createContext<ReleaseData | null>(null);

/**
 * JSON 을 내려받는다. 오류 문구는 화면에 그대로 보이므로 우리말로 쓴다.
 * SPA 재작성(vercel.json)과 서비스 워커의 오프라인 대체 때문에 파일이 없어도 HTML 이 200 으로 올 수 있어 본문을 직접 확인한다.
 */
async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-cache", headers: { Accept: "application/json" } });
  } catch {
    throw new Error(`${url} 에 연결하지 못했어요. 네트워크 상태를 확인해 주세요.`);
  }
  if (!response.ok) throw new Error(`${url} 응답이 ${response.status} 이에요.`);
  const text = await response.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error(`${url} 대신 HTML 페이지가 내려왔어요. 발행 파일이 배포에 들어 있는지 확인해 주세요.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${url} 내용이 JSON 형식이 아니에요.`);
  }
}

export function ReleaseDataProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<ReleaseDataStatus>("loading");
  const [releases, setReleases] = useState<ReleaseItem[]>([]);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    (async () => {
      const [itemsResult, metaResult] = await Promise.allSettled([fetchJson(RELEASES_URL), fetchJson(META_URL)]);
      if (cancelled) return;
      if (itemsResult.status === "rejected") {
        setError(itemsResult.reason instanceof Error ? itemsResult.reason.message : String(itemsResult.reason));
        setStatus("error");
        return;
      }
      try {
        const adapted = adaptReleases(itemsResult.value);
        setReleases(adapted.releases);
        setSkipped(adapted.skipped);
        const meta = metaResult.status === "fulfilled" ? (metaResult.value as PublishedMeta | null) : null;
        setPublishedAt(typeof meta?.publishedAt === "string" ? meta.publishedAt : null);
        setStatus("ready");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  const interests = useMemo(() => deriveInterests(releases), [releases]);

  const value = useMemo<ReleaseData>(
    () => ({ status, releases, interests, publishedAt, skipped, error, reload }),
    [error, interests, publishedAt, releases, reload, skipped, status],
  );

  return <ReleaseDataContext.Provider value={value}>{children}</ReleaseDataContext.Provider>;
}

export function useReleases(): ReleaseData {
  const context = useContext(ReleaseDataContext);
  if (!context) throw new Error("useReleases must be used inside ReleaseDataProvider");
  return context;
}
