import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import Dashboard from "./Dashboard.tsx";

const path = window.location.pathname;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{path.startsWith("/dashboard") ? <Dashboard /> : <App />}</StrictMode>,
);
