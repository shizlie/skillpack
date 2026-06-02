import { renderDashboardHtml as build } from "./ui/render-html.js";
import dashboardStyles from "./ui/styles.css";
import dashboardScript from "./ui/dist/dashboard.bundle.js";

export { dashboardStyles, dashboardScript };

export function renderDashboardHtml() {
  return build({ scriptUrl: "/assets/dashboard.js", styleUrl: "/assets/dashboard.css" });
}
