import { html } from "hono/html";

export function serveSelfHostedDashboard({ apiKey }) {
  return (c) => {
    const providedKey = c.req.header("x-api-key");
    if (providedKey) {
      return c.json({ error: "Use /v1/* for API calls" }, 404);
    }
    return c.html(renderDashboardHtml({ apiKeyPrefix: apiKey.slice(0, 8) }));
  };
}

function renderDashboardHtml({ apiKeyPrefix }) {
  return html`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Skillpack — Self-Hosted Dashboard</title>
        <style>${renderDashboardStyles()}</style>
      </head>
      <body>
        <div id="auth-screen">
          <h1>Skillpack Dashboard</h1>
          <p>Self-hosted mode — enter your API key to continue</p>
          <input type="password" id="api-key-input" placeholder="sk-..." />
          <button onclick="login()">Sign In</button>
          <p class="hint">API key starts with: ${apiKeyPrefix}...</p>
        </div>
        <div id="dashboard" style="display:none">
          <nav><a href="/">Home</a> | <a href="#providers">Providers</a> | <a href="#customers">Customers</a></nav>
          <main id="content">Loading...</main>
        </div>
        <script>
          async function login() {
            const key = document.getElementById('api-key-input').value;
            const res = await fetch('/v1/providers', { headers: { 'x-api-key': key } });
            if (res.ok) {
              localStorage.setItem('skillpack_api_key', key);
              document.getElementById('auth-screen').style.display = 'none';
              document.getElementById('dashboard').style.display = 'block';
              loadData();
            } else {
              alert('Invalid API key');
            }
          }
          async function loadData() {
            const key = localStorage.getItem('skillpack_api_key');
            const res = await fetch('/v1/providers', { headers: { 'x-api-key': key } });
            const data = await res.json();
            document.getElementById('content').innerText = JSON.stringify(data, null, 2);
          }
        </script>
      </body>
    </html>
  `;
}

function renderDashboardStyles() {
  return /* css */ `
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 2rem; }
    #auth-screen { text-align: center; margin-top: 20vh; }
    input { padding: 0.5rem; font-size: 1rem; width: 300px; }
    button { padding: 0.5rem 1rem; font-size: 1rem; margin-left: 0.5rem; cursor: pointer; }
    .hint { color: #666; font-size: 0.85rem; }
    nav { margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #ddd; }
  `;
}
