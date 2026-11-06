// Fonts for added and edited text (each loads only when used).
import "@fontsource/arimo/latin-400.css";
import "@fontsource/arimo/latin-700.css";
import "@fontsource/arimo/latin-400-italic.css";
import "@fontsource/arimo/latin-700-italic.css";
import "@fontsource/tinos/latin-400.css";
import "@fontsource/tinos/latin-700.css";
import "@fontsource/tinos/latin-400-italic.css";
import "@fontsource/tinos/latin-700-italic.css";
import "@fontsource/cousine/latin-400.css";
import "@fontsource/cousine/latin-700.css";
import "@fontsource/cousine/latin-400-italic.css";
import "@fontsource/cousine/latin-700-italic.css";
import "./vendor/pdfjs-annotation-layer.css";
import "./vendor/pdfjs-text-layer.css";
import "./styles.css";
import { App } from "./app";

new App(document.getElementById("app")!);
