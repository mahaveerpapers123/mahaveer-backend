const express = require('express');
const pool = require('../db');
const {
  serviceability,
  createOrder,
  assignAwb,
  generatePickup,
  generateManifest,
  printManifest,
  generateLabel
} = require('../lib/shiprocket');
const { recordOrderStatus } = require('../lib/inventory');

const router = express.Router();

function jsonValue(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function digits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function phone(value) {
  const normalized = digits(value);
  return normalized.length > 10 ? normalized.slice(-10) : normalized;
}

function pincode(value) {
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

function text(value, fallback = '') {
  return String(value ?? fallback).trim();
}

async function orderRows(id) {
  const result = await pool.query(
    `SELECT
       o.*,
       oi.id AS item_id,
       oi.product_id,
       oi.product_name,
       oi.sku,
       oi.barcode,
       oi.hsn_code,
       oi.quantity,
       oi.unit_price_minor,
       oi.subtotal_minor,
       oi.weight,
       oi.length,
       oi.width,
       oi.height,
       oi.hsn_percentage
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.id = $1
     ORDER BY oi.id`,
    [id]
  );
  return result.rows;
}

function packageDimensions(rows) {
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

function shiprocketItems(rows) {
  return rows
    .filter((row) => row.item_id)
    .map((row, index) => ({
      name: text(row.product_name, `Item ${index + 1}`).slice(0, 200),
      sku: text(row.sku, `ORD${String(row.id).replace(/-/g, '').slice(0, 8)}-${index + 1}`).slice(0, 100),
      units: positive(row.quantity, 1),
      selling_price: money(Number(row.unit_price_minor || 0) / 100),
      discount: 0,
      tax: 0,
      hsn: text(row.hsn_code)
    }));
}

function paymentMethod(order) {
  return String(order.payment_status || '').toUpperCase() === 'PAID' ? 'Prepaid' : 'COD';
}

function createPayload(order, rows) {
  const address = jsonValue(order.shipping_addr);
  const dimensions = packageDimensions(rows);
  const billingName = text(address.name || address.full_name || 'Customer');
  const billingPhone = phone(address.phone || address.phone_number);
  const billingPincode = pincode(address.postal_code || address.zip || address.pincode);

  return {
    order_id: String(order.id),
    order_date: new Date(order.created_at || Date.now()).toISOString().slice(0, 19).replace('T', ' '),
    pickup_location: text(process.env.SHIPROCKET_DEFAULT_PICKUP, 'warehouse'),
    channel_id: '',
    comment: text(order.customer_notes),
    reseller_name: '',
    company_name: '',
    billing_customer_name: billingName,
    billing_last_name: '',
    billing_address: text(address.line1 || address.address1),
    billing_address_2: text(address.line2 || address.address2),
    billing_city: text(address.city),
    billing_pincode: billingPincode,
    billing_state: text(address.state),
    billing_country: text(address.country || 'India'),
    billing_email: text(order.email || address.email),
    billing_phone: billingPhone,
    shipping_is_billing: true,
    shipping_customer_name: '',
    shipping_last_name: '',
    shipping_address: '',
    shipping_address_2: '',
    shipping_city: '',
    shipping_pincode: '',
    shipping_country: '',
    shipping_state: '',
    shipping_email: '',
    shipping_phone: '',
    order_items: shiprocketItems(rows),
    payment_method: paymentMethod(order),
    shipping_charges: money(Number(order.shipping_amount || 0) / 100),
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: money(Number(order.discount_amount || 0) / 100),
    sub_total: money(Number(order.subtotal_amount || order.total_amount || 0) / 100),
    length: dimensions.length,
    breadth: dimensions.breadth,
    height: dimensions.height,
    weight: dimensions.weight
  };
}

function validatePayload(payload) {
  const errors = [];
  if (!payload.pickup_location) errors.push('pickup_location is required');
  if (!payload.billing_customer_name) errors.push('billing_customer_name is required');
  if (!payload.billing_address) errors.push('billing_address is required');
  if (!payload.billing_city) errors.push('billing_city is required');
  if (!payload.billing_state) errors.push('billing_state is required');
  if (!payload.billing_country) errors.push('billing_country is required');
  if (!payload.billing_pincode || payload.billing_pincode.length !== 6) errors.push('billing_pincode must be 6 digits');
  if (!payload.billing_phone || payload.billing_phone.length < 10) errors.push('billing_phone must be valid');
  if (!payload.billing_email) errors.push('billing_email is required');
  if (!payload.order_items.length) errors.push('order_items are required');
  if (Number(payload.sub_total) <= 0) errors.push('sub_total must be greater than 0');
  if (Number(payload.weight) <= 0) errors.push('weight must be greater than 0');
  if (Number(payload.length) <= 0) errors.push('length must be greater than 0');
  if (Number(payload.breadth) <= 0) errors.push('breadth must be greater than 0');
  if (Number(payload.height) <= 0) errors.push('height must be greater than 0');
  return errors;
}

function ensureDeliveryOrder(order) {
  if (!order) return { status: 404, error: 'Order not found' };
  if (order.fulfillment_type !== 'DELIVERY') return { status: 422, error: 'Shiprocket is available only for delivery orders' };
  if (String(order.decision_status || '').toLowerCase() !== 'accepted') return { status: 409, error: 'Order must be accepted before creating a shipment' };
  if (['CANCELLED', 'COMPLETED'].includes(String(order.order_status || '').toUpperCase())) return { status: 409, error: `Order is ${order.order_status}` };
  return null;
}

async function recommendedCourier(rows) {
  const order = rows[0];
  const address = jsonValue(order.shipping_addr);
  const pickupPostcode = pincode(process.env.SHIPROCKET_PICKUP_PIN);
  const deliveryPostcode = pincode(address.postal_code || address.zip || address.pincode);
  if (!pickupPostcode) throw new Error('Missing SHIPROCKET_PICKUP_PIN env');
  if (!deliveryPostcode) throw new Error('Missing delivery pincode on order');
  const dimensions = packageDimensions(rows);
  const response = await serviceability({
    pickup_postcode: pickupPostcode,
    delivery_postcode: deliveryPostcode,
    weight: dimensions.weight,
    cod: paymentMethod(order) === 'COD' ? 1 : 0
  });
  const couriers = response?.data?.available_courier_companies || response?.available_courier_companies || [];
  return { response, couriers, recommended: couriers[0] || null, package: dimensions };
}

router.get('/orders/:id/shiprocket/couriers', async (req, res) => {
  try {
    const rows = await orderRows(req.params.id);
    const order = rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    const result = await recommendedCourier(rows);
    return res.json({ ok: true, package: result.package, couriers: result.couriers, raw: result.response });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error), raw: error.response || null });
  }
});

router.get('/orders/:id/shiprocket/debug', async (req, res) => {
  try {
    const rows = await orderRows(req.params.id);
    const order = rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    const payload = createPayload(order, rows);
    const courierResult = await recommendedCourier(rows).catch((error) => ({ error: String(error.message || error), raw: error.response || null }));
    return res.json({ ok: true, validationErrors: validatePayload(payload), payload, courierResult });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.post('/orders/:id/shiprocket/create', async (req, res) => {
  try {
    const rows = await orderRows(req.params.id);
    const order = rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });

    if (order.shiprocket_shipment_id) {
      return res.json({
        ok: true,
        already_created: true,
        shipment_id: order.shiprocket_shipment_id,
        shiprocket_order_id: order.shiprocket_order_id
      });
    }

    const payload = createPayload(order, rows);
    const errors = validatePayload(payload);
    if (errors.length) return res.status(400).json({ error: 'Local payload validation failed', validationErrors: errors, payload });

    const created = await createOrder(payload);
    const shipmentId = created?.shipment_id || created?.data?.shipment_id || null;
    const shiprocketOrderId = created?.order_id || created?.data?.order_id || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE orders
         SET shiprocket_shipment_id = $2,
             shiprocket_order_id = $3,
             shiprocket_last_status = 'CREATED',
             shiprocket_last_update = NOW(),
             fulfill_status = 'SHIPMENT_CREATED',
             updated_at = NOW()
         WHERE id = $1`,
        [order.id, shipmentId, shiprocketOrderId]
      );
      await recordOrderStatus(client, order.id, 'FULFILLMENT', order.fulfill_status, 'SHIPMENT_CREATED', 'Shiprocket shipment created');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return res.json({ ok: true, shipment_id: shipmentId, shiprocket_order_id: shiprocketOrderId, created });
  } catch (error) {
    return res.status(500).json({
      error: String(error.message || error),
      raw: error.response || null,
      requestPath: error.requestPath || null,
      requestBody: error.requestBody || null,
      requestQuery: error.requestQuery || null
    });
  }
});

router.post('/orders/:id/shiprocket/assign-awb', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    const order = result.rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    if (!order.shiprocket_shipment_id) return res.status(400).json({ error: 'Shipment not created yet' });

    const courierId = req.body?.courier_id ? Number(req.body.courier_id) : undefined;
    const response = await assignAwb({
      shipment_id: Number(order.shiprocket_shipment_id),
      courier_id: courierId,
      status: req.body?.status ? String(req.body.status) : undefined
    });

    const awb = response?.response?.data?.awb_code || response?.awb_code || response?.data?.awb_code || null;
    const courierName = response?.response?.data?.courier_name || response?.courier_name || response?.data?.courier_name || null;
    const courier = courierName || (courierId ? String(courierId) : order.shiprocket_courier || null);

    await pool.query(
      `UPDATE orders
       SET shiprocket_awb = $2,
           shiprocket_courier = $3,
           shiprocket_last_status = 'AWB_ASSIGNED',
           shiprocket_last_update = NOW(),
           fulfill_status = 'AWB_ASSIGNED',
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, awb, courier]
    );

    return res.json({ ok: true, awb, courier, raw: response });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error), raw: error.response || null });
  }
});

router.post('/orders/:id/shiprocket/rate-assign', async (req, res) => {
  try {
    const rows = await orderRows(req.params.id);
    const order = rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    if (!order.shiprocket_shipment_id) return res.status(400).json({ error: 'Shipment not created yet' });

    const courierResult = await recommendedCourier(rows);
    if (!courierResult.recommended) return res.status(400).json({ error: 'No serviceable courier found', raw: courierResult.response });

    const assigned = await assignAwb({
      shipment_id: Number(order.shiprocket_shipment_id),
      courier_id: Number(courierResult.recommended.courier_company_id)
    });

    const awb = assigned?.response?.data?.awb_code || assigned?.awb_code || assigned?.data?.awb_code || null;
    const courier = courierResult.recommended.courier_name || String(courierResult.recommended.courier_company_id);

    await pool.query(
      `UPDATE orders
       SET shiprocket_awb = $2,
           shiprocket_courier = $3,
           shiprocket_last_status = 'AWB_ASSIGNED',
           shiprocket_last_update = NOW(),
           fulfill_status = 'AWB_ASSIGNED',
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, awb, courier]
    );

    return res.json({ ok: true, courier: courierResult.recommended, awb, raw: assigned });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error), raw: error.response || null });
  }
});

router.post('/orders/:id/shiprocket/pickup', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    const order = result.rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    if (!order.shiprocket_shipment_id) return res.status(400).json({ error: 'Shipment not created yet' });

    const response = await generatePickup({
      shipment_id: [Number(order.shiprocket_shipment_id)],
      status: req.body?.status ? String(req.body.status) : undefined,
      pickup_date: req.body?.pickup_date ? [String(req.body.pickup_date)] : undefined
    });
    const pickupStatus = response?.pickup_status || response?.status || response?.message || 'PICKUP_REQUESTED';

    await pool.query(
      `UPDATE orders
       SET shiprocket_pickup_status = $2,
           shiprocket_last_status = 'PICKUP_REQUESTED',
           shiprocket_last_update = NOW(),
           fulfill_status = 'PICKUP_REQUESTED',
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, String(pickupStatus)]
    );

    return res.json({ ok: true, pickup_status: pickupStatus, raw: response });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error), raw: error.response || null });
  }
});

router.post('/orders/:id/shiprocket/manifest', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    const order = result.rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    if (!order.shiprocket_shipment_id) return res.status(400).json({ error: 'Shipment not created yet' });

    const generated = await generateManifest({ shipment_id: [Number(order.shiprocket_shipment_id)] });
    let printed = null;
    let manifestUrl = generated?.manifest_url || generated?.data?.manifest_url || null;

    if (!manifestUrl && order.shiprocket_order_id) {
      printed = await printManifest({ order_ids: [Number(order.shiprocket_order_id)] });
      manifestUrl = printed?.manifest_url || printed?.data?.manifest_url || null;
    }

    await pool.query(
      `UPDATE orders
       SET shiprocket_manifest_url = $2,
           shiprocket_last_status = 'MANIFEST_CREATED',
           shiprocket_last_update = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, manifestUrl]
    );

    return res.json({ ok: true, manifest_url: manifestUrl, generated, printed });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error), raw: error.response || null });
  }
});

router.post('/orders/:id/shiprocket/label', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [req.params.id]);
    const order = result.rows[0];
    const invalid = ensureDeliveryOrder(order);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    if (!order.shiprocket_shipment_id) return res.status(400).json({ error: 'Shipment not created yet' });

    const response = await generateLabel({ shipment_id: [Number(order.shiprocket_shipment_id)] });
    const labelUrl = response?.label_url || response?.data?.label_url || null;

    await pool.query(
      `UPDATE orders
       SET shiprocket_label_url = $2,
           shiprocket_last_status = 'LABEL_CREATED',
           shiprocket_last_update = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, labelUrl]
    );

    return res.json({ ok: true, label_url: labelUrl, raw: response });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error), raw: error.response || null });
  }
});

module.exports = router;
