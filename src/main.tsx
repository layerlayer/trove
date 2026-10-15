import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { TroveProvider } from "./context/TroveContext";
import { ReleaseDataProvider } from "./data/ReleaseDataContext";
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

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app remains usable if a preview environment blocks service workers.
    });
  });
}
