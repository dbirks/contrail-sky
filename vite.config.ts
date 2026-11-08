import { defineConfig } from "vite";

// BASE_PATH lets one build serve from a sub-path: the GitHub Pages job sets it to "/contrail-sky/".
// The default "./" (relative) keeps the container / local builds working at any path.
export default defineConfig({ base: process.env.BASE_PATH || "./" });
