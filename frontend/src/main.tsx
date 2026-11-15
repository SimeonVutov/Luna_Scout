import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import { App } from "./App";
import "./style.css";

// Retire the previous globe's generated textures without touching saved sites.
void globalThis.caches?.delete("lunascout-polar-textures-v1").catch(() => {});

createRoot(document.getElementById("root")!).render(<App />);
