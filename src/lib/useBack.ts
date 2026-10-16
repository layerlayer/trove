import { useNavigate } from "react-router-dom";

/**
 * 뒤로 가기. 앱 안에서 쌓인 이력이 있으면 한 단계 뒤로, 공유 링크나 새 탭으로 바로 열린 화면이면
 * fallback 으로 간다. idx 는 react-router 가 history.state 에 기록하는 항목 번호(첫 항목은 0).
 */
export function useBack(fallback = "/home") {
  const navigate = useNavigate();
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  };
}
