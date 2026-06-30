const express = require('express')
const router = express.Router()
const pool = require('../db')
const nodemailer = require('nodemailer')

const ROUTE_VERSION = 'orders@v8-email-only'

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
})

const mailFrom = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@mahaveerpapers.com'

function orderEmailHtml(order) {
  const items = Array.isArray(order.items) ? order.items : []
  let sumMinor = 0
  const rows = items
    .map((it) => {
      const qty = Number(it.quantity || 0)
      const unitMinor = Number(it.unit_price_minor || 0)
      const lineMinor = qty * unitMinor
      sumMinor += lineMinor
      const unit = unitMinor / 100
      const line = lineMinor / 100
      return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${it.product_name || ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${qty}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">₹${unit.toFixed(2)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">₹${line.toFixed(2)}</td>
      </tr>`
    })
    .join('')
  const totalMinorFromOrder = Number(order.total_amount || 0)
  const totalMinor = sumMinor > 0 ? sumMinor : totalMinorFromOrder
  const total = totalMinor / 100
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
      <h2 style="color:#0ea5e9;margin:0 0 8px">Your order has been accepted</h2>
      <p style="margin:0 0 16px">Thanks for ordering with Mahaveer Paper Enterprises. Here are your order details.</p>
      <div style="margin:16px 0;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc">
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div><strong>Order ID:</strong> ${order.id}</div>
          <div><strong>Date:</strong> ${order.created_at ? new Date(order.created_at).toLocaleString() : ''}</div>
          <div><strong>Payment:</strong> ${order.payment_status || '—'}</div>
          <div><strong>Status:</strong> Accepted</div>
        </div>
      </div>
      <h3 style="margin:16px 0 8px">Items</h3>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eee">
        <thead>
          <tr style="background:#f1f5f9">
            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e2e8f0">Product</th>
            <th style="padding:8px 12px;text-align:center;border-bottom:1px solid #e2e8f0">Qty</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #e2e8f0">Unit</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #e2e8f0">Subtotal</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="4" style="padding:12px;text-align:center;color:#64748b">No items</td></tr>`}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="padding:12px;text-align:right;font-weight:700">Order Total</td>
            <td style="padding:12px;text-align:right;font-weight:700">₹${total.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
      <p style="margin:20px 0 0">We’ll notify you when your order is dispatched. For any queries, reply to this email.</p>
    </div>`
}

async function getOrderDetail(id) {
  const q = `
    SELECT 
      o.id,
      o.created_at,
      o.email,
      o.total_amount,
      o.currency,
      o.payment_status,
      o.decision_status,
      o.shipping_addr,
      COALESCE(json_agg(
        json_build_object(
          'product_name', oi.product_name,
          'image_url', oi.image_url,
          'quantity', oi.quantity,
          'unit_price_minor', oi.unit_price_minor,
          'height', oi.height,
          'width', oi.width,
          'length', oi.length,
          'weight', oi.weight,
          'mahaveer_price', oi.mahaveer_price,
          'hsn_percentage', oi.hsn_percentage,
          'mrp', oi.mrp
        )
      ) FILTER (WHERE oi.order_id IS NOT NULL), '[]'::json) AS items
    FROM orders o
    LEFT JOIN order_items oi ON o.id = oi.order_id
    WHERE o.id = $1
    GROUP BY o.id
    LIMIT 1`
  const detail = await pool.query(q, [id])
  const row = detail.rows[0]
  if (row && typeof row.shipping_addr === 'string') {
    try {
      row.shipping_addr = JSON.parse(row.shipping_addr)
    } catch {
      row.shipping_addr = null
    }
  }
  return row
}

async function sendOrderAcceptedEmail(order) {
  if (!order?.email) return { emailSent: false, emailError: 'Missing recipient email' }
  try {
    await transporter.sendMail({
      from: mailFrom,
      to: order.email,
      subject: `Your order #${order.id} has been accepted`,
      html: orderEmailHtml(order)
    })
    return { emailSent: true, emailError: null }
  } catch (err) {
    return { emailSent: false, emailError: err?.message || 'SMTP error' }
  }
}

router.get('/', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        o.id,
        o.created_at,
        o.email,
        o.total_amount,
        o.currency,
        o.payment_status,
        o.order_status,
        o.fulfill_status,
        o.decision_status,
        o.decision_at,
        o.shipping_addr,
        o.shiprocket_awb,
        o.shiprocket_courier,
        o.shiprocket_last_status,
        o.shiprocket_last_update,
        o.shiprocket_shipment_id,
        o.shiprocket_tracking_json,
        o.payment_provider,
        o.paid_at,
        o.shiprocket_order_id,
        o.shiprocket_label_url,
        o.shiprocket_manifest_url,
        o.shiprocket_pickup_status,
        COALESCE(json_agg(
          json_build_object(
            'product_name', oi.product_name,
            'image_url', oi.image_url,
            'quantity', oi.quantity,
            'unit_price_minor', oi.unit_price_minor,
            'height', oi.height,
            'width', oi.width,
            'length', oi.length,
            'weight', oi.weight,
            'mahaveer_price', oi.mahaveer_price,
            'hsn_percentage', oi.hsn_percentage,
            'mrp', oi.mrp
          )
        ) FILTER (WHERE oi.order_id IS NOT NULL), '[]'::json) AS items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY
        CASE WHEN o.fulfill_status = 'Completed' THEN 1 ELSE 0 END,
        CASE WHEN o.decision_status = 'Accepted' THEN 0
             WHEN o.decision_status = 'Pending' THEN 1
             WHEN o.decision_status = 'Declined' THEN 2
             ELSE 3 END,
        o.created_at DESC`)
    res.setHeader('x-route-version', ROUTE_VERSION)
    res.json({ orders: result.rows, version: ROUTE_VERSION })
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch orders' })
  }
})

router.put('/:id/decision', async (req, res) => {
  const { id } = req.params
  const { decision } = req.body
  if (!['Accepted', 'Declined', 'Pending'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' })
  try {
    const upd = await pool.query(
      `UPDATE orders 
       SET decision_status = $1, decision_at = NOW()
       WHERE id = $2
       RETURNING id, email, decision_status, decision_at`,
      [decision, id]
    )
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Order not found' })
    let emailSent = false
    let emailError = null
    if (decision === 'Accepted') {
      const order = await getOrderDetail(id)
      if (!order) {
        emailError = 'Order detail not found after update'
      } else {
        const emailRes = await sendOrderAcceptedEmail(order)
        emailSent = emailRes.emailSent
        emailError = emailRes.emailError
      }
    }
    res.setHeader('x-route-version', ROUTE_VERSION)
    res.json({ order: upd.rows[0], emailSent, emailError, version: ROUTE_VERSION })
  } catch (e) {
    res.status(500).json({ error: 'Failed to update decision', version: ROUTE_VERSION })
  }
})

router.put('/:id/complete', async (req, res) => {
  const { id } = req.params
  try {
    const upd = await pool.query(
      `UPDATE orders
       SET fulfill_status = 'Completed',
           payment_status = 'Completed',
           decision_status = COALESCE(decision_status, 'Accepted'),
           decision_at = COALESCE(decision_at, NOW())
       WHERE id = $1
       RETURNING id, email, payment_status, fulfill_status, decision_status, decision_at`,
      [id]
    )
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Order not found' })
    res.json({ order: upd.rows[0] })
  } catch (e) {
    res.status(500).json({ error: 'Failed to complete order' })
  }
})

module.exports = router