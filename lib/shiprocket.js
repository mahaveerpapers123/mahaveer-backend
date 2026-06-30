const DEFAULT_BASE = "https://apiv2.shiprocket.in";

let cachedToken = null;
let cachedTokenExpiry = 0;

function getBaseUrl() {
  return (process.env.SHIPROCKET_BASE || DEFAULT_BASE).replace(/\/$/, "");
}

function getCredentials() {
  const email = process.env.SHIPROCKET_API_EMAIL || process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_API_PASSWORD || process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) {
    throw new Error("Missing Shiprocket credentials");
  }
  return { email, password };
}

function asJsonBody(body) {
  return body === undefined ? undefined : JSON.stringify(body);
}

function toQueryString(query) {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item === undefined || item === null || item === "") return;
        params.append(key, String(item));
      });
      return;
    }
    params.append(key, String(value));
  });
  const out = params.toString();
  return out ? `?${out}` : "";
}

async function parseResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function login(force = false) {
  const now = Date.now();
  if (!force && cachedToken && cachedTokenExpiry > now + 60000) {
    return cachedToken;
  }
  const { email, password } = getCredentials();
  const res = await fetch(`${getBaseUrl()}/v1/external/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  const data = await parseResponse(res);
  if (!res.ok) {
    const err = new Error(data?.message || `Shiprocket auth failed with status ${res.status}`);
    err.status = res.status;
    err.response = data;
    err.requestPath = "/v1/external/auth/login";
    err.requestBody = { email };
    throw err;
  }
  const token = data?.token || data?.data?.token;
  if (!token) {
    throw new Error("Shiprocket token missing in auth response");
  }
  cachedToken = token;
  cachedTokenExpiry = now + 6 * 60 * 60 * 1000;
  return token;
}

async function shiprocketRequest(path, { method = "GET", query, body, retry = true } = {}) {
  const token = await login(false);
  const res = await fetch(`${getBaseUrl()}${path}${toQueryString(query)}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: asJsonBody(body)
  });
  const data = await parseResponse(res);
  if (res.status === 401 && retry) {
    await login(true);
    return shiprocketRequest(path, { method, query, body, retry: false });
  }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `Shiprocket request failed with status ${res.status}`);
    err.status = res.status;
    err.response = data;
    err.requestPath = path;
    err.requestQuery = query || null;
    err.requestBody = body || null;
    throw err;
  }
  return data;
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function toIntArray(values) {
  return toArray(values)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
}

async function serviceability(params) {
  return shiprocketRequest("/v1/external/courier/serviceability", {
    method: "GET",
    query: params
  });
}

async function createOrder(payload) {
  return shiprocketRequest("/v1/external/orders/create/adhoc", {
    method: "POST",
    body: payload
  });
}

async function assignAwb(payload) {
  return shiprocketRequest("/v1/external/courier/assign/awb", {
    method: "POST",
    body: payload
  });
}

async function generatePickup(payload) {
  const body = {
    shipment_id: toIntArray(payload?.shipment_id)
  };
  if (payload?.status) body.status = payload.status;
  if (payload?.pickup_date) body.pickup_date = toArray(payload.pickup_date).map(String);
  return shiprocketRequest("/v1/external/courier/generate/pickup", {
    method: "POST",
    body
  });
}

async function generateManifest(payload) {
  return shiprocketRequest("/v1/external/manifests/generate", {
    method: "POST",
    body: {
      shipment_id: toIntArray(payload?.shipment_id)
    }
  });
}

async function printManifest(payload) {
  return shiprocketRequest("/v1/external/manifests/print", {
    method: "POST",
    body: {
      order_ids: toIntArray(payload?.order_ids)
    }
  });
}

async function generateLabel(payload) {
  return shiprocketRequest("/v1/external/courier/generate/label", {
    method: "POST",
    body: {
      shipment_id: toIntArray(payload?.shipment_id)
    }
  });
}

async function trackByAwb(awb) {
  return shiprocketRequest(`/v1/external/courier/track/awb/${encodeURIComponent(String(awb))}`, {
    method: "GET"
  });
}

async function trackByShipmentId(shipmentId) {
  return shiprocketRequest(`/v1/external/courier/track/shipment/${encodeURIComponent(String(shipmentId))}`, {
    method: "GET"
  });
}

module.exports = {
  login,
  serviceability,
  createOrder,
  assignAwb,
  assignAWB: assignAwb,
  generatePickup,
  generateManifest,
  printManifest,
  generateLabel,
  trackByAwb,
  trackByAWB: trackByAwb,
  trackByShipmentId
};