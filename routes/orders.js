const express = require('express');
const nodemailer = require('nodemailer');
const pool = require('../db');
const {
  generatePickupCode,
  hashPickupCode,
  commitOrderReservations,
  releaseOrderReservations,
  restoreCommittedOrderStock,
  recordOrderStatus
} = require('../lib/inventory');

const router = express.Router();
const ROUTE_VERSION = 'orders@v9-inventory-pickup';
const smtpConfigured = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: smtpConfigured
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined
});
const mailFrom = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@mahaveerpapers.com';

function text(value) {
  return String(value ?? '').trim();
}

function jsonValue(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function rupees(minor) {
  return (Number(minor || 0) / 100).toFixed(2);
}

function orderEmailHtml(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const rows = items
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${item.product_name || ''}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${Number(item.quantity || 0)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">₹${rupees(item.unit_price_minor)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">₹${rupees(item.subtotal_minor)}</td>
        </tr>`
    )
    .join('');

  const fulfillment = order.fulfillment_type === 'PICKUP' ? 'Store pickup' : 'Delivery';
  const nextMessage = order.fulfillment_type === 'PICKUP'
    ? 'We will notify you when the order is ready for pickup.'
    : 'We will notify you when the order is dispatched.';

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
      <h2 style="color:#0ea5e9;margin:0 0 8px">Your order has been accepted</h2>
      <p style="margin:0 0 16px">Thanks for ordering with Mahaveer Paper Enterprises.</p>
      <div style="margin:16px 0;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc">
        <div><strong>Order ID:</strong> ${order.id}</div>
        <div><strong>Fulfillment:</strong> ${fulfillment}</div>
        <div><strong>Payment:</strong> ${order.payment_method || order.payment_status || ''}</div>
        <div><strong>Status:</strong> Accepted</div>
      </div>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eee">
        <thead>
          <tr style="background:#f1f5f9">
            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e2e8f0">Product</th>
            <th style="padding:8px 12px;text-align:center;border-bottom:1px solid #e2e8f0">Qty</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #e2e8f0">Unit</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #e2e8f0">Subtotal</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="4" style="padding:12px;text-align:center;color:#64748b">No items</td></tr>'}</tbody>
        <tfoot>
          <tr><td colspan="3" style="padding:8px 12px;text-align:right">Subtotal</td><td style="padding:8px 12px;text-align:right">₹${rupees(order.subtotal_amount)}</td></tr>
          <tr><td colspan="3" style="padding:8px 12px;text-align:right">Shipping</td><td style="padding:8px 12px;text-align:right">₹${rupees(order.shipping_amount)}</td></tr>
          <tr><td colspan="3" style="padding:12px;text-align:right;font-weight:700">Order Total</td><td style="padding:12px;text-align:right;font-weight:700">₹${rupees(order.total_amount)}</td></tr>
        </tfoot>
      </table>
      <p style="margin:20px 0 0">${nextMessage}</p>
    </div>`;
}

async function getOrderDetail(client, id, lock = false) {
  if (lock) {
    const locked = await client.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked.rowCount) return null;
  }
  const result = await client.query(
    `SELECT
       o.*,
       l.name AS inventory_location_name,
       l.code AS inventory_location_code,
       COALESCE(
         json_agg(
           json_build_object(
             'id', oi.id,
             'product_id', oi.product_id,
             'product_name', oi.product_name,
             'sku', oi.sku,
             'barcode', oi.barcode,
             'brand', oi.brand,
             'category_slug', oi.category_slug,
             'image_url', oi.image_url,
             'quantity', oi.quantity,
             'unit_price_minor', oi.unit_price_minor,
             'subtotal_minor', oi.subtotal_minor,
             'height', oi.height,
             'width', oi.width,
             'length', oi.length,
             'weight', oi.weight,
             'mahaveer_price', oi.mahaveer_price,
             'hsn_code', oi.hsn_code,
             'hsn_percentage', oi.hsn_percentage,
             'mrp', oi.mrp,
             'unit', oi.unit,
             'pack_size', oi.pack_size
           ) ORDER BY oi.id
         ) FILTER (WHERE oi.id IS NOT NULL),
         '[]'::json
       ) AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN inventory_locations l ON l.id = o.inventory_location_id
     WHERE o.id = $1
     GROUP BY o.id, l.name, l.code
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function sendAcceptedEmail(order) {
  if (!smtpConfigured || !order?.email) return { emailSent: false, emailError: null };
  try {
    await transporter.sendMail({
      from: mailFrom,
      to: order.email,
      subject: `Your order #${order.id} has been accepted`,
      html: orderEmailHtml(order)
    });
    return { emailSent: true, emailError: null };
  } catch (error) {
    return { emailSent: false, emailError: String(error.message || error) };
  }
}

router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = [];

    if (req.query.fulfillmentType) {
      params.push(text(req.query.fulfillmentType).toUpperCase());
      where.push(`o.fulfillment_type = $${params.length}`);
    }

    if (req.query.status) {
      params.push(text(req.query.status));
      where.push(`(o.order_status ILIKE $${params.length} OR o.fulfill_status ILIKE $${params.length} OR o.decision_status ILIKE $${params.length})`);
    }

    if (req.query.paymentStatus) {
      params.push(text(req.query.paymentStatus).toUpperCase());
      where.push(`UPPER(o.payment_status) = $${params.length}`);
    }

    if (req.query.query) {
      params.push(`%${text(req.query.query)}%`);
      where.push(`(o.id::text ILIKE $${params.length} OR o.email ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT
         o.*,
         l.name AS inventory_location_name,
         l.code AS inventory_location_code,
         COALESCE(
           json_agg(
             json_build_object(
               'id', oi.id,
               'product_id', oi.product_id,
               'product_name', oi.product_name,
               'sku', oi.sku,
               'barcode', oi.barcode,
               'brand', oi.brand,
               'image_url', oi.image_url,
               'quantity', oi.quantity,
               'unit_price_minor', oi.unit_price_minor,
               'subtotal_minor', oi.subtotal_minor,
               'height', oi.height,
               'width', oi.width,
               'length', oi.length,
               'weight', oi.weight,
               'mahaveer_price', oi.mahaveer_price,
               'hsn_code', oi.hsn_code,
               'hsn_percentage', oi.hsn_percentage,
               'mrp', oi.mrp
             ) ORDER BY oi.id
           ) FILTER (WHERE oi.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN inventory_locations l ON l.id = o.inventory_location_id
       ${whereSql}
       GROUP BY o.id, l.name, l.code
       ORDER BY o.created_at DESC`,
      params
    );

    res.setHeader('x-route-version', ROUTE_VERSION);
    return res.json({ orders: result.rows, version: ROUTE_VERSION });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch orders', detail: String(error.message || error) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await getOrderDetail(pool, req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const history = await pool.query(
      `SELECT id, status_type, old_status, new_status, note, changed_by, created_at
       FROM order_status_history
       WHERE order_id = $1
       ORDER BY created_at`,
      [req.params.id]
    );

    const reservations = await pool.query(
      `SELECT id, order_item_id, product_id, location_id, quantity, status, expires_at, committed_at, released_at, created_at, updated_at
       FROM stock_reservations
       WHERE order_id = $1
       ORDER BY created_at`,
      [req.params.id]
    );

    return res.json({ order, history: history.rows, reservations: reservations.rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch order', detail: String(error.message || error) });
  }
});

router.put('/:id/decision', async (req, res) => {
  const client = await pool.connect();

  try {
    const decision = text(req.body?.decision);
    const reason = text(req.body?.reason || req.body?.note) || null;
    const changedBy = Number.isInteger(Number(req.body?.changedBy)) ? Number(req.body.changedBy) : null;

    if (!['Accepted', 'Declined', 'Pending'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid decision' });
    }

    await client.query('BEGIN');
    const order = await getOrderDetail(client, req.params.id, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const oldDecision = order.decision_status;
    const oldOrderStatus = order.order_status;
    const oldFulfillStatus = order.fulfill_status;
    const lockedStatus = String(order.order_status || '').toUpperCase();

    if (['CANCELLED', 'COMPLETED'].includes(lockedStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot change the decision for an order with status ${order.order_status}` });
    }

    if (decision === 'Accepted' && ['CANCELLED', 'COMPLETED', 'EXPIRED'].includes(lockedStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot accept an order with status ${order.order_status}` });
    }

    if (decision === 'Accepted') {
      if (order.payment_method === 'ONLINE' && String(order.payment_status).toUpperCase() !== 'PAID') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Online payment is not completed' });
      }

      await commitOrderReservations(client, order.id, 'Order accepted', changedBy);

      const fulfillStatus = order.fulfillment_type === 'PICKUP' ? 'READY_FOR_PICKUP' : 'PACKING';
      const pickupExpiryDays = Number(process.env.PICKUP_EXPIRY_DAYS || 7);

      await client.query(
        `UPDATE orders
         SET decision_status = 'Accepted',
             decision_at = NOW(),
             order_status = 'ACCEPTED',
             fulfill_status = $2,
             pickup_ready_at = CASE WHEN fulfillment_type = 'PICKUP' THEN COALESCE(pickup_ready_at, NOW()) ELSE pickup_ready_at END,
             pickup_expires_at = CASE
               WHEN fulfillment_type = 'PICKUP' THEN COALESCE(pickup_expires_at, NOW() + ($3::text || ' days')::interval)
               ELSE pickup_expires_at
             END,
             admin_notes = COALESCE($4, admin_notes),
             updated_at = NOW()
         WHERE id = $1`,
        [order.id, fulfillStatus, Number.isFinite(pickupExpiryDays) && pickupExpiryDays > 0 ? pickupExpiryDays : 7, reason]
      );

      await recordOrderStatus(client, order.id, 'DECISION', oldDecision, 'Accepted', reason, changedBy);
      await recordOrderStatus(client, order.id, 'ORDER', oldOrderStatus, 'ACCEPTED', reason, changedBy);
      await recordOrderStatus(client, order.id, 'FULFILLMENT', oldFulfillStatus, fulfillStatus, reason, changedBy);
    } else if (decision === 'Declined') {
      await releaseOrderReservations(client, order.id, reason || 'Order declined');
      await restoreCommittedOrderStock(client, order.id, reason || 'Order declined', changedBy);

      await client.query(
        `UPDATE orders
         SET decision_status = 'Declined',
             decision_at = NOW(),
             order_status = 'CANCELLED',
             fulfill_status = 'CANCELLED',
             cancelled_at = COALESCE(cancelled_at, NOW()),
             cancellation_reason = COALESCE($2, cancellation_reason, 'Order declined'),
             admin_notes = COALESCE($2, admin_notes),
             updated_at = NOW()
         WHERE id = $1`,
        [order.id, reason]
      );

      await recordOrderStatus(client, order.id, 'DECISION', oldDecision, 'Declined', reason, changedBy);
      await recordOrderStatus(client, order.id, 'ORDER', oldOrderStatus, 'CANCELLED', reason, changedBy);
      await recordOrderStatus(client, order.id, 'FULFILLMENT', oldFulfillStatus, 'CANCELLED', reason, changedBy);
    } else {
      await client.query(
        `UPDATE orders
         SET decision_status = 'Pending',
             decision_at = NOW(),
             admin_notes = COALESCE($2, admin_notes),
             updated_at = NOW()
         WHERE id = $1`,
        [order.id, reason]
      );
      await recordOrderStatus(client, order.id, 'DECISION', oldDecision, 'Pending', reason, changedBy);
    }

    await client.query('COMMIT');

    const updatedOrder = await getOrderDetail(pool, order.id);
    const emailResult = decision === 'Accepted'
      ? await sendAcceptedEmail(updatedOrder)
      : { emailSent: false, emailError: null };

    res.setHeader('x-route-version', ROUTE_VERSION);
    return res.json({ order: updatedOrder, ...emailResult, version: ROUTE_VERSION });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to update decision', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.put('/:id/ready', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const order = await getOrderDetail(client, req.params.id, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.fulfillment_type !== 'PICKUP') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Only pickup orders can be marked ready' });
    }

    if (String(order.decision_status || '').toLowerCase() !== 'accepted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order must be accepted before it can be marked ready' });
    }

    await client.query(
      `UPDATE orders
       SET fulfill_status = 'READY_FOR_PICKUP',
           order_status = 'READY_FOR_PICKUP',
           pickup_ready_at = COALESCE(pickup_ready_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [order.id]
    );

    await recordOrderStatus(client, order.id, 'FULFILLMENT', order.fulfill_status, 'READY_FOR_PICKUP', text(req.body?.note) || null, null);
    await client.query('COMMIT');

    return res.json({ order: await getOrderDetail(pool, order.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to mark pickup ready', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.post('/:id/pickup/code', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const order = await getOrderDetail(client, req.params.id, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.fulfillment_type !== 'PICKUP') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'This is not a pickup order' });
    }

    if (['CANCELLED', 'COMPLETED', 'EXPIRED'].includes(String(order.order_status || '').toUpperCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot generate a pickup code for an order with status ${order.order_status}` });
    }

    const code = generatePickupCode();
    const expiryDays = Number(process.env.PICKUP_EXPIRY_DAYS || 7);
    const safeDays = Number.isFinite(expiryDays) && expiryDays > 0 ? expiryDays : 7;

    await client.query(
      `UPDATE orders
       SET pickup_code_hash = $2,
           pickup_code_attempts = 0,
           pickup_expires_at = NOW() + ($3::text || ' days')::interval,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, hashPickupCode(code), safeDays]
    );

    await client.query('COMMIT');
    return res.json({ orderId: order.id, pickup_code: code, expires_in_days: safeDays });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to generate pickup code', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.post('/:id/pickup/verify', async (req, res) => {
  const client = await pool.connect();

  try {
    const code = text(req.body?.code);
    const receivedPaymentMethod = text(req.body?.paymentMethod || req.body?.payment_method).toUpperCase();
    const changedBy = Number.isInteger(Number(req.body?.changedBy)) ? Number(req.body.changedBy) : null;

    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'A valid 6 digit pickup code is required' });

    await client.query('BEGIN');
    const order = await getOrderDetail(client, req.params.id, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.fulfillment_type !== 'PICKUP') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'This is not a pickup order' });
    }

    if (order.picked_up_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order has already been picked up' });
    }

    if (String(order.fulfill_status || '').toUpperCase() !== 'READY_FOR_PICKUP') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not ready for pickup' });
    }

    if (Number(order.pickup_code_attempts || 0) >= 5) {
      await client.query('ROLLBACK');
      return res.status(429).json({ error: 'Too many invalid pickup code attempts' });
    }

    if (order.pickup_expires_at && new Date(order.pickup_expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Pickup code has expired' });
    }

    if (hashPickupCode(code) !== order.pickup_code_hash) {
      await client.query(
        `UPDATE orders
         SET pickup_code_attempts = pickup_code_attempts + 1, updated_at = NOW()
         WHERE id = $1`,
        [order.id]
      );
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Invalid pickup code' });
    }

    if (order.payment_method === 'ONLINE' && String(order.payment_status).toUpperCase() !== 'PAID') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Online payment is not completed' });
    }

    let finalPaymentMethod = order.payment_method;
    let finalPaymentStatus = order.payment_status;

    if (order.payment_method === 'PAY_AT_STORE') {
      if (!['CASH', 'UPI', 'CARD'].includes(receivedPaymentMethod)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Select CASH, UPI or CARD for store payment' });
      }
      finalPaymentMethod = receivedPaymentMethod;
      finalPaymentStatus = 'PAID';
    }

    await commitOrderReservations(client, order.id, 'Pickup completed', changedBy);

    await client.query(
      `UPDATE orders
       SET pickup_code_attempts = 0,
           pickup_verified_by = $2,
           picked_up_at = NOW(),
           payment_method = $3,
           payment_status = $4,
           order_status = 'COMPLETED',
           fulfill_status = 'COMPLETED',
           decision_status = COALESCE(decision_status, 'Accepted'),
           decision_at = COALESCE(decision_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, changedBy, finalPaymentMethod, finalPaymentStatus]
    );

    await recordOrderStatus(client, order.id, 'PAYMENT', order.payment_status, finalPaymentStatus, finalPaymentMethod, changedBy);
    await recordOrderStatus(client, order.id, 'ORDER', order.order_status, 'COMPLETED', 'Pickup verified', changedBy);
    await recordOrderStatus(client, order.id, 'FULFILLMENT', order.fulfill_status, 'COMPLETED', 'Customer collected order', changedBy);

    await client.query('COMMIT');
    return res.json({ order: await getOrderDetail(pool, order.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Pickup verification failed', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.put('/:id/complete', async (req, res) => {
  const client = await pool.connect();

  try {
    const changedBy = Number.isInteger(Number(req.body?.changedBy)) ? Number(req.body.changedBy) : null;
    const receivedPaymentMethod = text(req.body?.paymentMethod || req.body?.payment_method).toUpperCase();

    await client.query('BEGIN');
    const order = await getOrderDetail(client, req.params.id, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (['CANCELLED', 'EXPIRED'].includes(String(order.order_status || '').toUpperCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot complete an order with status ${order.order_status}` });
    }

    if (order.payment_method === 'ONLINE' && String(order.payment_status).toUpperCase() !== 'PAID') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Online payment is not completed' });
    }

    let paymentMethod = order.payment_method;
    let paymentStatus = order.payment_status;

    if (order.payment_method === 'PAY_AT_STORE') {
      if (!['CASH', 'UPI', 'CARD'].includes(receivedPaymentMethod)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Select CASH, UPI or CARD for store payment' });
      }
      paymentMethod = receivedPaymentMethod;
      paymentStatus = 'PAID';
    } else if (order.payment_method === 'COD') {
      paymentStatus = 'PAID';
    }

    await commitOrderReservations(client, order.id, 'Order completed', changedBy);

    await client.query(
      `UPDATE orders
       SET fulfill_status = 'COMPLETED',
           order_status = 'COMPLETED',
           payment_status = $2,
           payment_method = $3,
           picked_up_at = CASE WHEN fulfillment_type = 'PICKUP' THEN COALESCE(picked_up_at, NOW()) ELSE picked_up_at END,
           decision_status = COALESCE(decision_status, 'Accepted'),
           decision_at = COALESCE(decision_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, paymentStatus, paymentMethod]
    );

    await recordOrderStatus(client, order.id, 'PAYMENT', order.payment_status, paymentStatus, paymentMethod, changedBy);
    await recordOrderStatus(client, order.id, 'ORDER', order.order_status, 'COMPLETED', text(req.body?.note) || null, changedBy);
    await recordOrderStatus(client, order.id, 'FULFILLMENT', order.fulfill_status, 'COMPLETED', text(req.body?.note) || null, changedBy);

    await client.query('COMMIT');
    return res.json({ order: await getOrderDetail(pool, order.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to complete order', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.put('/:id/cancel', async (req, res) => {
  const client = await pool.connect();

  try {
    const reason = text(req.body?.reason) || 'Order cancelled';
    const changedBy = Number.isInteger(Number(req.body?.changedBy)) ? Number(req.body.changedBy) : null;

    await client.query('BEGIN');
    const order = await getOrderDetail(client, req.params.id, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (['COMPLETED', 'CANCELLED'].includes(String(order.order_status).toUpperCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Order is already ${order.order_status}` });
    }

    await releaseOrderReservations(client, order.id, reason);
    await restoreCommittedOrderStock(client, order.id, reason, changedBy);

    await client.query(
      `UPDATE orders
       SET order_status = 'CANCELLED',
           fulfill_status = 'CANCELLED',
           decision_status = CASE WHEN decision_status = 'Accepted' THEN decision_status ELSE 'Declined' END,
           cancelled_at = NOW(),
           cancellation_reason = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, reason]
    );

    await recordOrderStatus(client, order.id, 'ORDER', order.order_status, 'CANCELLED', reason, changedBy);
    await recordOrderStatus(client, order.id, 'FULFILLMENT', order.fulfill_status, 'CANCELLED', reason, changedBy);

    await client.query('COMMIT');
    return res.json({ order: await getOrderDetail(pool, order.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to cancel order', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

module.exports = router;
