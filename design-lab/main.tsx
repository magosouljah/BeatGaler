import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./tokens.css";
import "./lab.css";
import "./gallery.css";
import "./system/studio.css";

const root = document.getElementById("design-lab-root");
if (!root) throw new Error("Design Lab root missing");
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
