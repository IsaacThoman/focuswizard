import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsPage } from "./components/SettingsPage";
import "./index.css";
import "./components/Settings.css";

ReactDOM.createRoot(document.getElementById("settings-root")!).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>,
);
