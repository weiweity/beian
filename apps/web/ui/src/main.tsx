import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp } from "antd";
import { App } from "./App";
import { applyAppearance, loadAppearance } from "./chrome/appearance";
import { AppearanceRoot } from "./chrome/AppearanceRoot";
import "./styles/tokens.css";
import "./styles/app.css";

applyAppearance(
  loadAppearance(),
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

createRoot(root).render(
  <StrictMode>
    <AppearanceRoot>
      <AntApp>
        <App />
      </AntApp>
    </AppearanceRoot>
  </StrictMode>,
);
