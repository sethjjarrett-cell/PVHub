import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

function boot() {
  createRoot(document.getElementById("root")).render(<App />);
  requestAnimationFrame(() => {
    const b = document.getElementById("boot");
    if (!b) return;
    b.style.transition = "opacity .25s ease";
    b.style.opacity = "0";
    setTimeout(() => b.remove(), 280);
  });
}
// let the boot screen paint before the app mounts
requestAnimationFrame(() => setTimeout(boot, 0));
