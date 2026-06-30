const express = require("express");
const pool = require("../db");
const {
  serviceability,
  createOrder,
  assignAwb,
  generatePickup,
  generateManifest,
  printManifest,
  generateLabel
} = require("../lib/shiprocket");

const router = express.Router();

function safeJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function digits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function normalizePhone(value) {
  const d = digits(value);
  if (!d) return "";
  return d.length > 10 ? d.slice(-10) : d;
}

function normalizePincode(value) {
  return digits(value).slice(0, 6);
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeText(value, fallback = "") {
  return String(value || fallback).trim();
}

async function getOrderRows(id) {
  const q = await pool.query(
    `
    SELECT
      o.*,
      oi.id AS item_id,
      oi.product_id,
      oi.product_name,
      oi.quantity,
      oi.unit_price_minor,
      oi.weight,
      oi.length,
      oi.width,
      oi.height,
      oi.hsn_percentage
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.id = $1
    ORDER BY oi.product_name ASC NULLS LAST
    `,
    [id]
  );
  return q.rows;
}

function buildPackage(rows) {
  const items = rows.filter((row) => row.item_id);
  const totalWeight = items.reduce((sum, row) => sum + positive(row.weight, 0) * positive(row.quantity, 1), 0);
  const maxLength = items.reduce((max, row) => Math.max(max, positive(row.length, 0)), 0);
  const maxBreadth = items.reduce((max, row) => Math.max(max, positive(row.width, 0)), 0);
  const totalHeight = items.reduce((sum, row) => sum + positive(row.height, 0) * positive(row.quantity, 1), 0);
  return {
    weight: Number(positive(totalWeight, 0.5).toFixed(3)),
    length: Math.ceil(positive(maxLength, 12)),
    breadth: Math.ceil(positive(maxBreadth, 10)),
    height: Math.ceil(positive(totalHeight, 4))
  };
}

function buildShiprocketItems(rows) {
  return rows
    .filter((row) => row.item_id)
    .map((row, index) => ({
      name: safeText(row.product_name, `Item ${index + 1}`).slice(0, 200),
      sku: `ORD${String(row.order_id).replace(/-/g, "").slice(0, 8)}-${index + 1}`,
      units: positive(row.quantity, 1),
      selling_price: money(Number(row.unit_price_minor || 0) / 100),
      discount: 0,
      tax: 0,
      hsn: ""
    }));
}

function getDeliveryAddress(order) {
  return safeJson(order.shipping_addr);
}

function getPaymentMethod(order) {
  const status = String(order.payment_status || "").toUpperCase();
  return status === "PAID" || status === "COMPLETED" ? "Prepaid" : "COD";
}

function buildCreatePayload(order, rows) {
  const addr = getDeliveryAddress(order);
  const pkg = buildPackage(rows);
  const items = buildShiprocketItems(rows);
  const pickup = safeText(process.env.SHIPROCKET_DEFAULT_PICKUP, "warehouse");
  const billingName = safeText(addr.name || addr.full_name || "Customer");
  const billingPhone = normalizePhone(addr.phone || addr.phone_number || "");
  const billingCity = safeText(addr.city);
  const billingState = safeText(addr.state);
  const billingPincode = normalizePincode(addr.postal_code || addr.zip || addr.pincode || "");
  const billingCountry = safeText(addr.country || "India");
  const billingAddress1 = safeText(addr.line1 || addr.address1);
  const billingAddress2 = safeText(addr.line2 || addr.address2);
  const billingEmail = safeText(order.email || addr.email);
  const subTotal = money(Number(order.total_amount || 0) / 100);

  return {
    order_id: String(order.id),
    order_date: new Date(order.created_at || Date.now()).toISOString().slice(0, 19).replace("T", " "),
    pickup_location: pickup,
    channel_id: "",
    comment: "",
    reseller_name: "",
    company_name: "",
    billing_customer_name: billingName,
    billing_last_name: "",
    billing_address: billingAddress1,
    billing_address_2: billingAddress2,
    billing_city: billingCity,
    billing_pincode: billingPincode,
    billing_state: billingState,
    billing_country: billingCountry,
    billing_email: billingEmail,
    billing_phone: billingPhone,
    shipping_is_billing: true,
    shipping_customer_name: "",
    shipping_last_name: "",
    shipping_address: "",
    shipping_address_2: "",
    shipping_city: "",
    shipping_pincode: "",
    shipping_country: "",
    shipping_state: "",
    shipping_email: "",
    shipping_phone: "",
    order_items: items,
    payment_method: getPaymentMethod(order),
    shipping_charges: 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: subTotal,
    length: pkg.length,
    breadth: pkg.breadth,
    height: pkg.height,
    weight: pkg.weight
  };
}

function validateCreatePayload(payload) {
  const errors = [];
  if (!payload.pickup_location) errors.push("pickup_location is required");
  if (!payload.billing_customer_name) errors.push("billing_customer_name is required");
  if (!payload.billing_address) errors.push("billing_address is required");
  if (!payload.billing_city) errors.push("billing_city is required");
  if (!payload.billing_state) errors.push("billing_state is required");
  if (!payload.billing_country) errors.push("billing_country is required");
  if (!payload.billing_pincode || payload.billing_pincode.length !== 6) errors.push("billing_pincode must be 6 digits");
  if (!payload.billing_phone || payload.billing_phone.length < 10) errors.push("billing_phone must be valid");
  if (!payload.billing_email) errors.push("billing_email is required");
  if (!Array.isArray(payload.order_items) || payload.order_items.length === 0) errors.push("order_items are required");
  if (!payload.sub_total || Number(payload.sub_total) <= 0) errors.push("sub_total must be greater than 0");
  if (!payload.weight || Number(payload.weight) <= 0) errors.push("weight must be greater than 0");
  if (!payload.length || Number(payload.length) <= 0) errors.push("length must be greater than 0");
  if (!payload.breadth || Number(payload.breadth) <= 0) errors.push("breadth must be greater than 0");
  if (!payload.height || Number(payload.height) <= 0) errors.push("height must be greater than 0");
  return errors;
}

function debugOrder(order, rows, payload) {
  const addr = getDeliveryAddress(order);
  return {
    env: {
      SHIPROCKET_DEFAULT_PICKUP: process.env.SHIPROCKET_DEFAULT_PICKUP || null,
      SHIPROCKET_PICKUP_PIN: process.env.SHIPROCKET_PICKUP_PIN || null,
      SHIPROCKET_BASE: process.env.SHIPROCKET_BASE || null
    },
    order: {
      id: order.id,
      created_at: order.created_at,
      email: order.email,
      payment_status: order.payment_status,
      total_amount: order.total_amount,
      currency: order.currency
    },
    shipping_addr: addr,
    item_count: rows.filter((r) => r.item_id).length,
    payload
  };
}

async function pickRecommendedCourier(rows) {
  const order = rows[0];
  const addr = getDeliveryAddress(order);
  const pickupPin = normalizePincode(process.env.SHIPROCKET_PICKUP_PIN || "");
  if (!pickupPin) {
    throw new Error("Missing SHIPROCKET_PICKUP_PIN env");
  }
  const pkg = buildPackage(rows);
  const deliveryPin = normalizePincode(addr.postal_code || addr.zip || addr.pincode || "");
  if (!deliveryPin) {
    throw new Error("Missing delivery pincode on order");
  }
  const resp = await serviceability({
    pickup_postcode: pickupPin,
    delivery_postcode: deliveryPin,
    weight: pkg.weight,
    cod: getPaymentMethod(order) === "COD" ? 1 : 0
  });
  const couriers = resp?.data?.available_courier_companies || resp?.available_courier_companies || [];
  return { resp, couriers, recommended: couriers[0] || null, pkg };
}

router.get("/orders/:id/shiprocket/couriers", async (req, res) => {
  try {
    const rows = await getOrderRows(req.params.id);
    if (!rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = rows[0];
    const addr = getDeliveryAddress(order);
    const pickupPin = normalizePincode(process.env.SHIPROCKET_PICKUP_PIN || "");
    if (!pickupPin) {
      return res.status(400).json({ error: "Missing SHIPROCKET_PICKUP_PIN env" });
    }
    const pkg = buildPackage(rows);
    const deliveryPin = normalizePincode(addr.postal_code || addr.zip || addr.pincode || "");
    if (!deliveryPin) {
      return res.status(400).json({ error: "Missing delivery pincode on order" });
    }
    const response = await serviceability({
      pickup_postcode: pickupPin,
      delivery_postcode: deliveryPin,
      weight: pkg.weight,
      cod: getPaymentMethod(order) === "COD" ? 1 : 0
    });
    const couriers = response?.data?.available_courier_companies || response?.available_courier_companies || [];
    res.json({ ok: true, package: pkg, couriers, raw: response });
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || null,
      requestQuery: e?.requestQuery || null
    });
  }
});

router.get("/orders/:id/shiprocket/debug", async (req, res) => {
  try {
    const rows = await getOrderRows(req.params.id);
    if (!rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = rows[0];
    const payload = buildCreatePayload(order, rows);
    const validationErrors = validateCreatePayload(payload);
    const courierResult = await pickRecommendedCourier(rows).catch((e) => ({
      error: String(e.message || e),
      raw: e?.response || null
    }));
    res.json({
      ok: true,
      validationErrors,
      debug: debugOrder(order, rows, payload),
      courierResult
    });
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || null,
      requestQuery: e?.requestQuery || null
    });
  }
});

router.post("/orders/:id/shiprocket/create", async (req, res) => {
  try {
    const rows = await getOrderRows(req.params.id);
    if (!rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = rows[0];
    if (order.shiprocket_shipment_id) {
      return res.json({
        ok: true,
        already_created: true,
        shipment_id: order.shiprocket_shipment_id,
        shiprocket_order_id: order.shiprocket_order_id
      });
    }

    const payload = buildCreatePayload(order, rows);
    const validationErrors = validateCreatePayload(payload);

    if (validationErrors.length) {
      return res.status(400).json({
        error: "Local payload validation failed",
        validationErrors,
        debug: debugOrder(order, rows, payload)
      });
    }

    const created = await createOrder(payload);
    const shipmentId = created?.shipment_id || created?.data?.shipment_id || null;
    const shiprocketOrderId = created?.order_id || created?.data?.order_id || null;

    await pool.query(
      `
      UPDATE orders
      SET shiprocket_shipment_id = $2,
          shiprocket_order_id = $3,
          shiprocket_last_status = 'CREATED',
          shiprocket_last_update = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id, shipmentId, shiprocketOrderId]
    );

    res.json({
      ok: true,
      shipment_id: shipmentId,
      shiprocket_order_id: shiprocketOrderId,
      created,
      debug: debugOrder(order, rows, payload)
    });
  } catch (e) {
    const rows = await getOrderRows(req.params.id).catch(() => []);
    const order = rows[0] || null;
    const payload = order ? buildCreatePayload(order, rows) : null;
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || payload,
      requestQuery: e?.requestQuery || null,
      debug: order ? debugOrder(order, rows, payload) : null
    });
  }
});

router.post("/orders/:id/shiprocket/assign-awb", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (!q.rowCount) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = q.rows[0];
    if (!order.shiprocket_shipment_id) {
      return res.status(400).json({ error: "Shipment not created yet" });
    }

    const courierId = req.body?.courier_id ? Number(req.body.courier_id) : undefined;
    const status = req.body?.status ? String(req.body.status) : undefined;
    const response = await assignAwb({
      shipment_id: Number(order.shiprocket_shipment_id),
      courier_id: courierId,
      status
    });

    const awbCode = response?.response?.data?.awb_code || response?.awb_code || response?.data?.awb_code || null;
    const courierName = response?.response?.data?.courier_name || response?.courier_name || response?.data?.courier_name || null;
    const courierValue = courierName || (courierId ? String(courierId) : order.shiprocket_courier || null);

    await pool.query(
      `
      UPDATE orders
      SET shiprocket_awb = $2,
          shiprocket_courier = $3,
          shiprocket_last_status = 'AWB_ASSIGNED',
          shiprocket_last_update = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id, awbCode, courierValue]
    );

    res.json({ ok: true, awb: awbCode, courier: courierValue, raw: response });
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || null,
      requestQuery: e?.requestQuery || null
    });
  }
});

router.post("/orders/:id/shiprocket/rate-assign", async (req, res) => {
  try {
    const rows = await getOrderRows(req.params.id);
    if (!rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = rows[0];
    if (!order.shiprocket_shipment_id) {
      return res.status(400).json({ error: "Shipment not created yet" });
    }

    const { recommended, resp, pkg } = await pickRecommendedCourier(rows);
    if (!recommended) {
      return res.status(400).json({ error: "No serviceable courier found", raw: resp, package: pkg });
    }

    const assigned = await assignAwb({
      shipment_id: Number(order.shiprocket_shipment_id),
      courier_id: Number(recommended.courier_company_id)
    });

    const awbCode = assigned?.response?.data?.awb_code || assigned?.awb_code || assigned?.data?.awb_code || null;
    const courierValue = recommended.courier_name || String(recommended.courier_company_id);

    await pool.query(
      `
      UPDATE orders
      SET shiprocket_awb = $2,
          shiprocket_courier = $3,
          shiprocket_last_status = 'AWB_ASSIGNED',
          shiprocket_last_update = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id, awbCode, courierValue]
    );

    res.json({ ok: true, courier: recommended, awb: awbCode, raw: assigned });
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || null,
      requestQuery: e?.requestQuery || null
    });
  }
});

router.post("/orders/:id/shiprocket/pickup", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (!q.rowCount) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = q.rows[0];
    if (!order.shiprocket_shipment_id) {
      return res.status(400).json({ error: "Shipment not created yet" });
    }

    const response = await generatePickup({
      shipment_id: [Number(order.shiprocket_shipment_id)],
      status: req.body?.status ? String(req.body.status) : undefined,
      pickup_date: req.body?.pickup_date ? [String(req.body.pickup_date)] : undefined
    });

    const pickupStatus = response?.pickup_status || response?.status || response?.message || "PICKUP_REQUESTED";

    await pool.query(
      `
      UPDATE orders
      SET shiprocket_pickup_status = $2,
          shiprocket_last_status = 'PICKUP_REQUESTED',
          shiprocket_last_update = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id, String(pickupStatus)]
    );

    res.json({ ok: true, pickup_status: pickupStatus, raw: response });
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || null,
      requestQuery: e?.requestQuery || null
    });
  }
});

router.post("/orders/:id/shiprocket/manifest", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (!q.rowCount) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = q.rows[0];
    if (!order.shiprocket_shipment_id) {
      return res.status(400).json({ error: "Shipment not created yet" });
    }

    const generated = await generateManifest({
      shipment_id: [Number(order.shiprocket_shipment_id)]
    });

    let printed = null;
    let manifestUrl = generated?.manifest_url || generated?.data?.manifest_url || null;

    if (!manifestUrl && order.shiprocket_order_id) {
      printed = await printManifest({
        order_ids: [Number(order.shiprocket_order_id)]
      });
      manifestUrl = printed?.manifest_url || printed?.data?.manifest_url || null;
    }

    await pool.query(
      `
      UPDATE orders
      SET shiprocket_manifest_url = $2,
          shiprocket_last_status = 'MANIFEST_CREATED',
          shiprocket_last_update = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id, manifestUrl]
    );

    res.json({ ok: true, manifest_url: manifestUrl, generated, printed });
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || null,
      requestQuery: e?.requestQuery || null
    });
  }
});

router.post("/orders/:id/shiprocket/label", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (!q.rowCount) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = q.rows[0];
    if (!order.shiprocket_shipment_id) {
      return res.status(400).json({ error: "Shipment not created yet" });
    }

    const response = await generateLabel({
      shipment_id: [Number(order.shiprocket_shipment_id)]
    });
    const labelUrl = response?.label_url || response?.data?.label_url || null;

    await pool.query(
      `
      UPDATE orders
      SET shiprocket_label_url = $2,
          shiprocket_last_status = 'LABEL_CREATED',
          shiprocket_last_update = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id, labelUrl]
    );

    res.json({ ok: true, label_url: labelUrl, raw: response });
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e),
      raw: e?.response || null,
      requestPath: e?.requestPath || null,
      requestBody: e?.requestBody || null,
      requestQuery: e?.requestQuery || null
    });
  }
});

module.exports = router;