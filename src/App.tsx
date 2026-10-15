import { type PropsWithChildren, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { StatusBar } from "./components/StatusBar";
import { useTrove } from "./context/TroveContext";
import { useReleases } from "./data/ReleaseDataContext";
import { CalendarPage } from "./pages/CalendarPage";
import { DetailPage } from "./pages/DetailPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { HomePage } from "./pages/HomePage";
import { PreferencesPage } from "./pages/PreferencesPage";
import { ProfilePage } from "./pages/ProfilePage";
import { TrovePage } from "./pages/TrovePage";
import { EntityPage } from "./pages/EntityPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { AboutPage, PrivacyPage, TermsPage } from "./pages/InfoPages";
import { NotFoundPage } from "./pages/NotFoundPage";

/** 새 화면으로 갈 때만 맨 위로. 뒤로 가기(POP)는 각 화면이 자리를 되살린다 */
function ScrollToTop() {
  const location = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType === "POP") return;
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname, navigationType]);
  return null;
}

/** 발행물을 다 읽기 전에는 화면을 그리지 않는다. 실패하면 다시 시도 버튼 */
function DataGate({ children }: PropsWithChildren) {
  const data = useReleases();
  if (data.status === "ready") return <>{children}</>;
  return (
    <main className="app-page data-screen" aria-busy={data.status === "loading"}>
      <StatusBar />
      <div className="data-screen__body" role="status">
        {data.status === "loading" ? (
          <>
            <strong>기다림을 불러오는 중이에요</strong>
            <p>운영 콘솔이 발행한 출시 일정을 읽고 있어요.</p>
          </>
        ) : (
          <>
            <strong>출시 일정을 불러오지 못했어요</strong>
            <p>발행된 출시 일정 파일을 읽지 못했어요. 잠시 후 다시 시도해 주세요.</p>
            {data.error ? <small>{data.error}</small> : null}
            <button className="primary-button" type="button" onClick={data.reload}>다시 시도</button>
          </>
        )}
      </div>
    </main>
  );
}

function StartRoute() {
  const { state } = useTrove();
  return <Navigate to={state.onboardingComplete ? "/home" : "/preferences"} replace />;
}

export default function App() {
  return (
    <div className="app-shell">
      <ScrollToTop />
      <DataGate>
        <Routes>
          <Route path="/" element={<StartRoute />} />
          <Route path="/preferences" element={<PreferencesPage />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/trove" element={<TrovePage />} />
          <Route path="/trove/calendar" element={<CalendarPage />} />
          <Route path="/calendar" element={<Navigate to="/trove" replace />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/release/:slug" element={<DetailPage />} />
          <Route path="/entity/:slug" element={<EntityPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </DataGate>
    </div>
  );
}
