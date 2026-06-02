// apps/cli/src/http.js
export async function fetchWithRequest(serverUrl, { method, path, body }, { headers, fetchImpl }) {
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetchImpl(new Request(`${serverUrl}${path}`, init));
  return { status: response.status, body: await response.json() };
}
