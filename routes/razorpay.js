const express = require('express');
const pool = require('../db');
const {
  createOrder,
  fetchPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature
} = require('../lib/razorpay');
const {
  commitOrderReservations,
  recordOrderStatus
} = require('../lib/inventory');

const router = express.Router();

function toIsoFromUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function mapPaymentStatus(rawStatus, captured) {
  if (captured) return 'PAID';
  switch (String(rawStatus || '').toLowerCase()) {
    case 'captured':
      return 'PAID';
    case 'failed':
      return 'FAILED';
    case 'refunded':
      return 'REFUNDED';
    case 'authorized':
    case 'created':
    case 'attempted':
      return 'PENDING';
    default:
      return 'PENDING';
  }
}

async function getOrder(client, orderId, lock = false) {
  const result = await client.query(
    `SELECT *
     FROM orders
     WHERE id = $1
     ${lock ? 'FOR UPDATE' : ''}
     LIMIT 1`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function getLatestPaymentByOrder(client, orderId) {
  const result = await client.query(
    `SELECT *
     FROM payments
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function upsertPayment(client, payload) {
  if (payload.provider_payment_id) {
    const result = await client.query(
      `UPDATE payments
       SET provider_order_id = COALESCE($2, provider_order_id),
           provider_signature = COALESCE($4, provider_signature),
           receipt = COALESCE($5, receipt),
           amount_minor = CASE WHEN $6::integer > 0 THEN $6 ELSE amount_minor END,
           currency = COALESCE($7, currency),
           status = COALESCE($8, status),
           method = COALESCE($9, method),
           captured = $10,
           notes = COALESCE($11::jsonb, notes),
           raw_create_response = COALESCE($12::jsonb, raw_create_response),
           raw_verify_response = COALESCE($13::jsonb, raw_verify_response),
           raw_webhook_payload = COALESCE($14::jsonb, raw_webhook_payload),
           paid_at = COALESCE($15::timestamptz, paid_at),
           updated_at = NOW()
       WHERE provider_payment_id = $3
       RETURNING *`,
      [
        payload.order_id,
        payload.provider_order_id || null,
        payload.provider_payment_id,
        payload.provider_signature || null,
        payload.receipt || null,
        Number(payload.amount_minor || 0),
        payload.currency || 'INR',
        payload.status || 'PENDING',
        payload.method || null,
        Boolean(payload.captured),
        JSON.stringify(payload.notes || {}),
        payload.raw_create_response ? JSON.stringify(payload.raw_create_response) : null,
        payload.raw_verify_response ? JSON.stringify(payload.raw_verify_response) : null,
        payload.raw_webhook_payload ? JSON.stringify(payload.raw_webhook_payload) : null,
        payload.paid_at || null
      ]
    );
    if (result.rowCount) return result.rows[0];
  }

  if (payload.provider_order_id) {
    const result = await client.query(
      `UPDATE payments
       SET provider_payment_id = COALESCE($3, provider_payment_id),
           provider_signature = COALESCE($4, provider_signature),
           receipt = COALESCE($5, receipt),
           amount_minor = CASE WHEN $6::integer > 0 THEN $6 ELSE amount_minor END,
           currency = COALESCE($7, currency),
           status = COALESCE($8, status),
           method = COALESCE($9, method),
           captured = $10,
           notes = COALESCE($11::jsonb, notes),
           raw_create_response = COALESCE($12::jsonb, raw_create_response),
           raw_verify_response = COALESCE($13::jsonb, raw_verify_response),
           raw_webhook_payload = COALESCE($14::jsonb, raw_webhook_payload),
           paid_at = COALESCE($15::timestamptz, paid_at),
           updated_at = NOW()
       WHERE provider_order_id = $2
       RETURNING *`,
      [
        payload.order_id,
        payload.provider_order_id,
        payload.provider_payment_id || null,
        payload.provider_signature || null,
        payload.receipt || null,
        Number(payload.amount_minor || 0),
        payload.currency || 'INR',
        payload.status || 'PENDING',
        payload.method || null,
        Boolean(payload.captured),
        JSON.stringify(payload.notes || {}),
        payload.raw_create_response ? JSON.stringify(payload.raw_create_response) : null,
        payload.raw_verify_response ? JSON.stringify(payload.raw_verify_response) : null,
        payload.raw_webhook_payload ? JSON.stringify(payload.raw_webhook_payload) : null,
        payload.paid_at || null
      ]
    );
    if (result.rowCount) return result.rows[0];
  }

  const result = await client.query(
    `INSERT INTO payments (
       order_id,
       provider,
       provider_order_id,
       provider_payment_id,
       provider_signature,
       receipt,
       amount_minor,
       currency,
       status,
       method,
       captured,
       notes,
       raw_create_response,
       raw_verify_response,
       raw_webhook_payload,
       paid_at,
       created_at,
       updated_at
     ) VALUES (
       $1, 'razorpay', $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, NOW(), NOW()
     )
     RETURNING *`,
    [
      payload.order_id,
      payload.provider_order_id || null,
      payload.provider_payment_id || null,
      payload.provider_signature || null,
      payload.receipt || null,
      Number(payload.amount_minor || 0),
      payload.currency || 'INR',
      payload.status || 'PENDING',
      payload.method || null,
      Boolean(payload.captured),
      JSON.stringify(payload.notes || {}),
      payload.raw_create_response ? JSON.stringify(payload.raw_create_response) : null,
      payload.raw_verify_response ? JSON.stringify(payload.raw_verify_response) : null,
      payload.raw_webhook_payload ? JSON.stringify(payload.raw_webhook_payload) : null,
      payload.paid_at || null
    ]
  );

  return result.rows[0];
}

async function applyPaymentState(client, order, status, paidAt, note) {
  const oldStatus = String(order.payment_status || 'PENDING').toUpperCase();

  await client.query(
    `UPDATE orders
     SET payment_provider = 'razorpay',
         payment_status = $2,
         order_status = CASE
           WHEN $2 = 'PAID' AND order_status = 'PENDING' THEN 'PAID'
           ELSE order_status
         END,
         paid_at = CASE WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz ELSE paid_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [order.id, status, paidAt || null]
  );

  if (status === 'PAID' && !['CANCELLED', 'EXPIRED'].includes(String(order.order_status || '').toUpperCase())) {
    await commitOrderReservations(client, order.id, 'Online payment completed', null);
  }

  if (oldStatus !== status) {
    await recordOrderStatus(client, order.id, 'PAYMENT', oldStatus, status, note || null, null);
  }
}

router.post('/order', async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const order = await getOrder(client, orderId, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_method !== 'ONLINE') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'This order is not configured for online payment' });
    }

    if (String(order.payment_status).toUpperCase() === 'PAID') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is already paid' });
    }

    if (['CANCELLED', 'COMPLETED', 'EXPIRED'].includes(String(order.order_status).toUpperCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot pay an order with status ${order.order_status}` });
    }

    const amount = Number(order.total_amount || 0);
    const currency = String(order.currency || 'INR').toUpperCase();

    if (!Number.isInteger(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid order amount' });
    }

    const existing = await getLatestPaymentByOrder(client, order.id);
    if (existing?.provider_order_id && ['PENDING', 'created', 'authorized'].includes(String(existing.status))) {
      await client.query('COMMIT');
      return res.json({
        ok: true,
        key: process.env.RAZORPAY_KEY_ID,
        orderId: order.id,
        razorpayOrderId: existing.provider_order_id,
        amount: existing.amount_minor,
        currency: existing.currency,
        receipt: existing.receipt,
        reused: true
      });
    }

    const receipt = `order_${String(order.id).replace(/-/g, '').slice(0, 32)}`;
    const razorpayOrder = await createOrder({
      amount,
      currency,
      receipt,
      notes: {
        internal_order_id: String(order.id),
        email: String(order.email || '')
      }
    });

    await upsertPayment(client, {
      order_id: order.id,
      provider_order_id: razorpayOrder.id,
      receipt: razorpayOrder.receipt || receipt,
      amount_minor: Number(razorpayOrder.amount || amount),
      currency: razorpayOrder.currency || currency,
      status: mapPaymentStatus(razorpayOrder.status, false),
      notes: razorpayOrder.notes || {},
      raw_create_response: razorpayOrder,
      captured: false
    });

    await client.query(
      `UPDATE orders
       SET payment_provider = 'razorpay', payment_status = 'PENDING', updated_at = NOW()
       WHERE id = $1`,
      [order.id]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      key: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      receipt: razorpayOrder.receipt,
      reused: false
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.post('/verify', async (req, res) => {
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

  if (!orderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({
      error: 'orderId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const order = await getOrder(client, orderId, true);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (['CANCELLED', 'EXPIRED'].includes(String(order.order_status || '').toUpperCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot verify payment for an ${String(order.order_status).toLowerCase()} order` });
    }

    const latestPayment = await getLatestPaymentByOrder(client, order.id);

    if (!latestPayment?.provider_order_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No Razorpay order found for this order' });
    }

    if (latestPayment.provider_order_id !== razorpay_order_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Razorpay order id mismatch' });
    }

    const verified = verifyCheckoutSignature({
      razorpay_order_id: latestPayment.provider_order_id,
      razorpay_payment_id,
      razorpay_signature
    });

    if (!verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    const payment = await fetchPayment(razorpay_payment_id);
    const paymentStatus = mapPaymentStatus(payment?.status, Boolean(payment?.captured));
    const paidAt = paymentStatus === 'PAID'
      ? toIsoFromUnix(payment?.created_at) || new Date().toISOString()
      : null;

    if (Number(payment?.amount || 0) !== Number(order.total_amount || 0)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Payment amount does not match order total' });
    }

    await upsertPayment(client, {
      order_id: order.id,
      provider_order_id: latestPayment.provider_order_id,
      provider_payment_id: razorpay_payment_id,
      provider_signature: razorpay_signature,
      receipt: latestPayment.receipt || null,
      amount_minor: Number(payment?.amount || order.total_amount || 0),
      currency: payment?.currency || order.currency || 'INR',
      status: paymentStatus,
      method: payment?.method || null,
      captured: Boolean(payment?.captured),
      notes: payment?.notes || {},
      raw_verify_response: payment,
      paid_at: paidAt
    });

    await applyPaymentState(client, order, paymentStatus, paidAt, 'Razorpay checkout verification');
    await client.query('COMMIT');

    return res.json({
      ok: true,
      verified: true,
      orderId,
      razorpayOrderId: latestPayment.provider_order_id,
      razorpayPaymentId: razorpay_payment_id,
      paymentStatus
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.get('/payment-status/:orderId', async (req, res) => {
  try {
    const order = await getOrder(pool, req.params.orderId, false);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const paymentResult = await pool.query(
      `SELECT *
       FROM payments
       WHERE order_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.params.orderId]
    );

    return res.json({
      ok: true,
      order: {
        id: order.id,
        payment_provider: order.payment_provider,
        payment_method: order.payment_method,
        payment_status: order.payment_status,
        paid_at: order.paid_at
      },
      payment: paymentResult.rows[0] || null
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.post('/webhook', async (req, res) => {
  const signature = req.get('x-razorpay-signature') || '';
  const eventId = req.get('x-razorpay-event-id') || '';
  const rawBody = req.rawBody
    ? Buffer.from(req.rawBody)
    : Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}), 'utf8');

  try {
    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8') || '{}');
    const eventType = String(payload?.event || 'unknown');
    const effectiveEventId = eventId || `${eventType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const paymentEntity = payload?.payload?.payment?.entity || null;
    const orderEntity = payload?.payload?.order?.entity || null;
    const providerOrderId = paymentEntity?.order_id || orderEntity?.id || null;
    const providerPaymentId = paymentEntity?.id || null;
    const internalOrderIdFromNotes = orderEntity?.notes?.internal_order_id || paymentEntity?.notes?.internal_order_id || null;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const eventInsert = await client.query(
        `INSERT INTO provider_webhook_events (
           provider,
           event_id,
           event_type,
           signature,
           payload,
           processed,
           received_at
         ) VALUES ('razorpay', $1, $2, $3, $4::jsonb, false, NOW())
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [effectiveEventId, eventType, signature, JSON.stringify(payload)]
      );

      if (!eventInsert.rowCount) {
        await client.query('ROLLBACK');
        return res.json({ ok: true, duplicate: true });
      }

      let internalOrderId = internalOrderIdFromNotes;

      if (!internalOrderId && providerOrderId) {
        const lookup = await client.query(
          `SELECT order_id
           FROM payments
           WHERE provider_order_id = $1
           LIMIT 1`,
          [providerOrderId]
        );
        internalOrderId = lookup.rows[0]?.order_id || null;
      }

      const status = mapPaymentStatus(
        paymentEntity?.status || orderEntity?.status,
        Boolean(paymentEntity?.captured || eventType === 'payment.captured' || eventType === 'order.paid')
      );
      const paidAt = status === 'PAID'
        ? toIsoFromUnix(paymentEntity?.created_at) || new Date().toISOString()
        : null;

      if (internalOrderId) {
        const order = await getOrder(client, internalOrderId, true);

        if (order) {
          await upsertPayment(client, {
            order_id: internalOrderId,
            provider_order_id: providerOrderId,
            provider_payment_id: providerPaymentId,
            amount_minor: Number(paymentEntity?.amount || orderEntity?.amount || order.total_amount || 0),
            currency: paymentEntity?.currency || orderEntity?.currency || order.currency || 'INR',
            status,
            method: paymentEntity?.method || null,
            captured: Boolean(paymentEntity?.captured || eventType === 'payment.captured' || eventType === 'order.paid'),
            notes: paymentEntity?.notes || orderEntity?.notes || {},
            raw_webhook_payload: payload,
            paid_at: paidAt
          });

          await applyPaymentState(client, order, status, paidAt, eventType);
        }
      }

      await client.query(
        `UPDATE provider_webhook_events
         SET processed = true, processed_at = NOW()
         WHERE provider = 'razorpay' AND event_id = $1`,
        [effectiveEventId]
      );

      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

module.exports = router;
