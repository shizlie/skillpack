import { renderDashboardHtml as build } from "./ui/render-html.js";
import dashboardStyles from "./ui/styles.css";
export { dashboardStyles };

export function renderDashboardHtml() {
  return build({ scriptUrl: "/assets/dashboard.js", styleUrl: "/assets/dashboard.css" });
}

// Bundle the browser entry point into a single self-contained script.
// This runs once at Worker startup; the result is served verbatim from
// /assets/dashboard.js.
const built = await Bun.build({
  entrypoints: [import.meta.dir + "/ui/index.js"],
  format: "esm",
  bundle: true,
  target: "browser",
  minify: false,
});

if (!built.success) {
  throw new AggregateError(built.logs, "dashboard script build failed");
}

export const dashboardScript = await built.outputs[0].text();
