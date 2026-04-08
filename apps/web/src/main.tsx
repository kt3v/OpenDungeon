import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const gameId = import.meta.env.VITE_GAME_MODULE_ID || "default";
const pageModule = await import(`./${gameId}/page.tsx`);
const PageComponent = pageModule.default;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PageComponent />
  </StrictMode>
);
