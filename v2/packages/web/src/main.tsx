import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, ShellErrorBoundary } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("V2 shell root is missing");
createRoot(root).render(<StrictMode><ShellErrorBoundary><App /></ShellErrorBoundary></StrictMode>);
