import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "./styles/base.css";
import "./styles/layout.css";
import { App } from "./App";

// Retire the previous globe's generated textures without touching saved sites.
void globalThis.caches?.delete("lunascout-polar-textures-v1").catch(() => {});

createRoot(document.getElementById("root")!).render(<App />);
