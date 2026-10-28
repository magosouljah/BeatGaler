import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./shared/tokens.css";
import "./LANDING/landing.css";
import "./GALLERY/gallery.css";

const root = document.getElementById("design-lab-root");
if (!root) throw new Error("Design Lab root missing");
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
