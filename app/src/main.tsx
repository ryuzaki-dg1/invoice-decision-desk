import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./App.css";
import History from "./pages/History.tsx";
import InvoicePage from "./pages/Invoice.tsx";
import Overview from "./pages/Overview.tsx";
import Policy from "./pages/Policy.tsx";
import Process from "./pages/Process.tsx";
import Queue from "./pages/Queue.tsx";
import Reference from "./pages/Reference.tsx";

function route() {
  const p = window.location.pathname.replace(/\/+$/, "") || "/";
  const inv = p.match(/^\/invoice\/([^/]+)$/);
  if (inv) return <InvoicePage id={decodeURIComponent(inv[1])} />;
  switch (p) {
    case "/process":
      return <Process />;
    case "/queue":
      return <Queue />;
    case "/history":
      return <History />;
    case "/reference":
      return <Reference />;
    case "/policy":
      return <Policy />;
    default:
      return <Overview />;
  }
}

createRoot(document.getElementById("root")!).render(<StrictMode>{route()}</StrictMode>);
