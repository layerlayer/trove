import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { StatusBar } from "../components/StatusBar";
import { track } from "../lib/analytics";

export function NotFoundPage() {
  const navigate = useNavigate();
  useEffect(() => track("info_view", { page: "not_found", path: window.location.pathname }), []);
  return (
    <main className="app-page not-found-page">
      <StatusBar />
      <div className="empty-state">
        <strong>이런 페이지는 없어요</strong>
        <p>주소가 바뀌었거나 잘못 적혔을 수 있어요. 홈에서 기다림을 이어가 보세요.</p>
        <button className="primary-button" type="button" onClick={() => navigate("/home", { replace: true })}>
          홈으로 가기
        </button>
      </div>
    </main>
  );
}
