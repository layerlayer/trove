import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTrove } from "./context/TroveContext";
import { CalendarPage } from "./pages/CalendarPage";
import { DetailPage } from "./pages/DetailPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { HomePage } from "./pages/HomePage";
import { PreferencesPage } from "./pages/PreferencesPage";
import { ProfilePage } from "./pages/ProfilePage";
import { TrovePage } from "./pages/TrovePage";

function ScrollToTop() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);
  return null;
}

function StartRoute() {
  const { state } = useTrove();
  return <Navigate to={state.onboardingComplete ? "/home" : "/preferences"} replace />;
}

export default function App() {
  return (
    <div className="app-shell">
      <ScrollToTop />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
