const express = require('express');
const pool = require('../db');

const router = express.Router();

function text(value) {
  return String(value ?? '').trim();
}

function isValidGstin(value) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(text(value).toUpperCase());
}

function positiveInt(value, fallback, max = 500) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

router.get('/users', async (req, res) => {
  try {
    const params = [];
    const where = [];

    if (req.query.type) {
      params.push(text(req.query.type).toLowerCase());
      where.push(`user_type = $${params.length}`);
    }

    if (req.query.query) {
      params.push(`%${text(req.query.query)}%`);
      where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length} OR COALESCE(gst_number, '') ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, name, email, phone, user_type, gst_number, gst_verified, auth_provider, profile_image, email_verified, is_active, created_at, updated_at
       FROM "Users"
       ${whereSql}
       ORDER BY created_at DESC NULLS LAST, id DESC`,
      params
    );

    return res.json({ users: result.rows });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.patch('/users/:id/type', async (req, res) => {
  const userType = text(req.body?.userType).toLowerCase();
  const gstVerified = req.body?.gstVerified === true;

  if (!['b2c', 'b2b'].includes(userType)) return res.status(400).json({ error: 'Invalid userType' });

  try {
    const current = await pool.query(
      `SELECT id, gst_number
       FROM "Users"
       WHERE id = $1
       LIMIT 1`,
      [req.params.id]
    );

    if (!current.rowCount) return res.status(404).json({ error: 'User not found' });

    if (userType === 'b2b') {
      if (!current.rows[0].gst_number) return res.status(422).json({ error: 'GST number required' });
      if (!isValidGstin(current.rows[0].gst_number)) return res.status(422).json({ error: 'Invalid GST number' });
    }

    const result = await pool.query(
      `UPDATE "Users"
       SET user_type = $2,
           gst_verified = CASE WHEN $2 = 'b2b' THEN $3 ELSE false END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, email, phone, user_type, gst_number, gst_verified, is_active, created_at, updated_at`,
      [req.params.id, userType, gstVerified]
    );

    return res.json({ user: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.patch('/users/:id/active', async (req, res) => {
  try {
    const isActive = req.body?.isActive === true;
    const result = await pool.query(
      `UPDATE "Users"
       SET is_active = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, email, user_type, is_active, updated_at`,
      [req.params.id, isActive]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.get('/dashboard', async (_req, res) => {
  try {
    const [orders, products, inventory, payments, customers] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total_orders,
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today_orders,
           COUNT(*) FILTER (WHERE fulfillment_type = 'DELIVERY')::int AS delivery_orders,
           COUNT(*) FILTER (WHERE fulfillment_type = 'PICKUP')::int AS pickup_orders,
           COUNT(*) FILTER (WHERE order_status = 'PENDING')::int AS pending_orders,
           COUNT(*) FILTER (WHERE order_status = 'COMPLETED')::int AS completed_orders,
           COUNT(*) FILTER (WHERE order_status = 'CANCELLED')::int AS cancelled_orders,
           COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'PAID'), 0)::bigint AS paid_revenue_minor
         FROM orders`
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE is_active = true AND deleted_at IS NULL)::int AS active_products,
           COUNT(*) FILTER (WHERE is_active = false OR deleted_at IS NOT NULL)::int AS archived_products
         FROM "Products"`
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE stock_status = 'LOW_STOCK')::int AS low_stock_products,
           COUNT(*) FILTER (WHERE stock_status = 'OUT_OF_STOCK')::int AS out_of_stock_products,
           COALESCE(SUM(on_hand), 0) AS total_on_hand,
           COALESCE(SUM(reserved), 0) AS total_reserved
         FROM inventory_summary
         WHERE location_code = 'MAIN-SHOP'`
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_payments,
           COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_payments,
           COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_payments,
           COALESCE(SUM(amount_minor) FILTER (WHERE status = 'PAID'), 0)::bigint AS captured_amount_minor
         FROM payments`
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS total_customers,
           COUNT(*) FILTER (WHERE user_type = 'b2b')::int AS b2b_customers,
           COUNT(*) FILTER (WHERE user_type = 'b2c')::int AS b2c_customers
         FROM "Users"
         WHERE is_active = true`
      )
    ]);

    return res.json({
      orders: orders.rows[0],
      products: products.rows[0],
      inventory: inventory.rows[0],
      payments: payments.rows[0],
      customers: customers.rows[0]
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.get('/transactions', async (req, res) => {
  try {
    const page = positiveInt(req.query.page, 1, 100000);
    const limit = positiveInt(req.query.limit, 50, 500);
    const offset = (page - 1) * limit;
    const params = [];
    const where = [];

    if (req.query.status) {
      params.push(text(req.query.status).toUpperCase());
      where.push(`UPPER(COALESCE(p.status, o.payment_status)) = $${params.length}`);
    }

    if (req.query.method) {
      params.push(text(req.query.method).toUpperCase());
      where.push(`UPPER(COALESCE(p.method, o.payment_method, '')) = $${params.length}`);
    }

    if (req.query.fulfillmentType) {
      params.push(text(req.query.fulfillmentType).toUpperCase());
      where.push(`o.fulfillment_type = $${params.length}`);
    }

    if (req.query.query) {
      params.push(`%${text(req.query.query)}%`);
      where.push(`(o.id::text ILIKE $${params.length} OR o.email ILIKE $${params.length} OR COALESCE(p.provider_payment_id, '') ILIKE $${params.length})`);
    }

    if (req.query.dateFrom) {
      params.push(req.query.dateFrom);
      where.push(`o.created_at >= $${params.length}::date`);
    }

    if (req.query.dateTo) {
      params.push(req.query.dateTo);
      where.push(`o.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dataParams = [...params, limit, offset];

    const result = await pool.query(
      `SELECT
         o.id AS order_id,
         o.created_at,
         o.email,
         o.customer_type,
         o.fulfillment_type,
         o.order_channel,
         o.payment_method,
         o.payment_status,
         o.order_status,
         o.fulfill_status,
         o.total_amount,
         o.subtotal_amount,
         o.shipping_amount,
         o.discount_amount,
         o.tax_amount,
         p.id AS payment_id,
         p.provider,
         p.provider_order_id,
         p.provider_payment_id,
         p.status AS provider_status,
         p.method AS provider_method,
         p.captured,
         p.paid_at
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT *
         FROM payments payment_row
         WHERE payment_row.order_id = o.id
         ORDER BY payment_row.created_at DESC
         LIMIT 1
       ) p ON true
       ${whereSql}
       ORDER BY o.created_at DESC
       LIMIT $${dataParams.length - 1}
       OFFSET $${dataParams.length}`,
      dataParams
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT *
         FROM payments payment_row
         WHERE payment_row.order_id = o.id
         ORDER BY payment_row.created_at DESC
         LIMIT 1
       ) p ON true
       ${whereSql}`,
      params
    );

    return res.json({ page, limit, total: countResult.rows[0].total, transactions: result.rows });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

module.exports = router;
