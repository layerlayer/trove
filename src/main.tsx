import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { TroveProvider } from "./context/TroveContext";
import { ReleaseDataProvider } from "./data/ReleaseDataContext";
import { startAnalytics } from "./lib/analytics";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <TroveProvider>
        <ReleaseDataProvider>
          <App />
        </ReleaseDataProvider>
      </TroveProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

// 페이지를 열 때 한 번 app_open. 서버 모드(Supabase 환경 변수 있음)면 첫 화면을 그린 뒤 세션을 확인하고 기록을 보낸다
startAnalytics();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app remains usable if a preview environment blocks service workers.
    });
  });
}
