import http from "node:http";
import https from "node:https";

function requestJson(url, { headers, body, timeoutMs }) {
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsedBody = null;
          if (rawBody.length > 0) {
            try {
              parsedBody = JSON.parse(rawBody);
            } catch {
              parsedBody = rawBody;
            }
          }
          if ((response.statusCode ?? 500) >= 400) {
            const error = new Error(`meter_upload_http_${response.statusCode}`);
            error.statusCode = response.statusCode;
            error.body = parsedBody;
            reject(error);
            return;
          }
          if (parsedBody?.accepted === false) {
            const error = new Error(parsedBody.error ?? "meter_upload_rejected");
            error.statusCode = response.statusCode;
            error.body = parsedBody;
            reject(error);
            return;
          }
          resolve({
            statusCode: response.statusCode ?? 200,
            body: parsedBody,
          });
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("meter_upload_timeout"));
    });
    request.write(body);
    request.end();
  });
}

export function createDirectUploadTransport({
  baseUrl,
  pathname = "/v1/meter/upload",
  timeoutMs = 5_000,
  headers = {},
} = {}) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("direct_upload_missing_base_url");
  }
  const uploadUrl = new URL(pathname, baseUrl);

  return {
    async upload({ leaseToken, events = [] } = {}) {
      if (typeof leaseToken !== "string" || leaseToken.length === 0) {
        throw new Error("direct_upload_missing_lease_token");
      }
      return requestJson(uploadUrl, {
        timeoutMs,
        headers: {
          "x-skillpack-lease-token": leaseToken,
          ...headers,
        },
        body: JSON.stringify({ events }),
      });
    },
  };
}

export function createNoopUploadTransport() {
  return {
    async upload() {
      throw new Error("meter_upload_disabled");
    },
  };
}
