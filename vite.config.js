import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" keeps asset paths relative, so the build works on GitHub Pages
// (which serves from /<repo-name>/) as well as from a plain folder.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
