import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import EmbedApp from "./EmbedApp.jsx";
import { EMBEDDED } from "./data.js";
import "./styles.css";
createRoot(document.getElementById("root")).render(
  <React.StrictMode>{EMBEDDED ? <EmbedApp /> : <App />}</React.StrictMode>,
);
