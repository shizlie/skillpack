import crypto from "node:crypto";

/**
 * Shared management-auth predicate used by both the HTTP adapter layer
 * (server.js) and the route handler layer (routes.js).
 *
 * @param {Request} request
 * @param {{ managementApiKey: string|null, managementAuthenticator: Function|null }} opts
 * @returns {Promise<null|{status:number,body:{error:string}}>}
 *   null on success; a plain { status, body } error object on failure.
 */
export async function verifyManagementKey(request, { managementApiKey, managementAuthenticator }) {
  if (typeof managementAuthenticator === "function") {
    try {
      return (await managementAuthenticator(request)) === true
        ? null
        : { status: 401, body: { error: "unauthorized" } };
    } catch {
      return { status: 401, body: { error: "unauthorized" } };
    }
  }
  if (!managementApiKey) {
    return { status: 503, body: { error: "management_api_key_not_configured" } };
  }
  const providedApiKey =
    request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
  if (
    typeof providedApiKey !== "string" ||
    providedApiKey.length !== managementApiKey.length
  ) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const h = (k) => crypto.createHash("sha256").update(k).digest();
  if (!crypto.timingSafeEqual(h(providedApiKey), h(managementApiKey))) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return null;
}
