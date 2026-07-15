const DEFAULT_BASE = 'https://apiv2.shiprocket.in';
let cachedToken = null;
let cachedTokenExpiry = 0;

function baseUrl() {
  return String(process.env.SHIPROCKET_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function credentials() {
  const email = process.env.SHIPROCKET_API_EMAIL || process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_API_PASSWORD || process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) throw new Error('Missing Shiprocket credentials');
  return { email, password };
}

function queryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.append(key, String(value));
  }
  const output = params.toString();
  return output ? `?${output}` : '';
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function requestWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SHIPROCKET_TIMEOUT_MS || 30000));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function login(force = false) {
  const now = Date.now();
  if (!force && cachedToken && cachedTokenExpiry > now + 60000) return cachedToken;

  const { email, password } = credentials();
  const response = await requestWithTimeout(`${baseUrl()}/v1/external/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await parseResponse(response);

  if (!response.ok) {
    const error = new Error(data?.message || `Shiprocket auth failed with status ${response.status}`);
    error.status = response.status;
    error.response = data;
    error.requestPath = '/v1/external/auth/login';
    error.requestBody = { email };
    throw error;
  }

  const token = data?.token || data?.data?.token;
  if (!token) throw new Error('Shiprocket token missing in auth response');
  cachedToken = token;
  cachedTokenExpiry = now + 6 * 60 * 60 * 1000;
  return token;
}

async function shiprocketRequest(path, options = {}) {
  const method = options.method || 'GET';
  const token = await login(false);
  const response = await requestWithTimeout(`${baseUrl()}${path}${queryString(options.query)}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await parseResponse(response);

  if (response.status === 401 && options.retry !== false) {
    await login(true);
    return shiprocketRequest(path, { ...options, retry: false });
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Shiprocket request failed with status ${response.status}`);
    error.status = response.status;
    error.response = data;
    error.requestPath = path;
    error.requestQuery = options.query || null;
    error.requestBody = options.body || null;
    throw error;
  }

  return data;
}

function array(value) {
  return Array.isArray(value) ? value : [value];
}

function integerArray(value) {
  return array(value).map(Number).filter(Number.isFinite);
}

function serviceability(params) {
  return shiprocketRequest('/v1/external/courier/serviceability', { method: 'GET', query: params });
}

function createOrder(payload) {
  return shiprocketRequest('/v1/external/orders/create/adhoc', { method: 'POST', body: payload });
}

function assignAwb(payload) {
  return shiprocketRequest('/v1/external/courier/assign/awb', { method: 'POST', body: payload });
}

function generatePickup(payload) {
  const body = { shipment_id: integerArray(payload?.shipment_id) };
  if (payload?.status) body.status = payload.status;
  if (payload?.pickup_date) body.pickup_date = array(payload.pickup_date).map(String);
  return shiprocketRequest('/v1/external/courier/generate/pickup', { method: 'POST', body });
}

function generateManifest(payload) {
  return shiprocketRequest('/v1/external/manifests/generate', {
    method: 'POST',
    body: { shipment_id: integerArray(payload?.shipment_id) }
  });
}

function printManifest(payload) {
  return shiprocketRequest('/v1/external/manifests/print', {
    method: 'POST',
    body: { order_ids: integerArray(payload?.order_ids) }
  });
}

function generateLabel(payload) {
  return shiprocketRequest('/v1/external/courier/generate/label', {
    method: 'POST',
    body: { shipment_id: integerArray(payload?.shipment_id) }
  });
}

function trackByAwb(awb) {
  return shiprocketRequest(`/v1/external/courier/track/awb/${encodeURIComponent(String(awb))}`, { method: 'GET' });
}

function trackByShipmentId(shipmentId) {
  return shiprocketRequest(`/v1/external/courier/track/shipment/${encodeURIComponent(String(shipmentId))}`, { method: 'GET' });
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
