const express = require('express');
const pool = require('../db');
const { trackByAwb, trackByShipmentId } = require('../lib/shiprocket');
const { recordOrderStatus } = require('../lib/inventory');

const router = express.Router();

function normalize(response) {
  const data = response?.tracking_data || {};
  const tracks = Array.isArray(data.shipment_track) ? data.shipment_track : data.shipment_track ? [data.shipment_track] : [];
  const activities = Array.isArray(data.shipment_track_activities) ? data.shipment_track_activities : [];
  const primary = tracks[0] || {};
  const status = primary.current_status || data.current_status || data.shipment_status_label || data.shipment_status || data.track_status || 'Unknown';
  const awb = primary.awb_code || data.awb_code || response?.awb_code || null;
  const courier = primary.courier_name || data.courier_name || response?.courier_name || null;

  return {
    status: String(status),
    awb,
    courier,
    checkpoints: activities.map((item) => ({
      date: item.date || item.activity_date || null,
      activity: item.activity || item.status || item['sr-status'] || item.location || '',
      location: item.location || item.delivered_to || item.destination || ''
    }))
  };
}

function localFulfillmentStatus(status) {
  const value = String(status || '').toUpperCase();
  if (value.includes('RTO')) return 'RETURN_TO_ORIGIN';
  if (value.includes('DELIVERED')) return 'COMPLETED';
  if (value.includes('OUT FOR DELIVERY')) return 'OUT_FOR_DELIVERY';
  if (value.includes('IN TRANSIT') || value.includes('SHIPPED')) return 'IN_TRANSIT';
  if (value.includes('PICKED')) return 'SHIPPED';
  if (value.includes('CANCEL')) return 'CANCELLED';
  return value.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNKNOWN';
}

router.get('/', async (req, res) => {
  try {
    const orderId = req.query.orderId || null;
    const awb = req.query.awb || null;
    const shipmentId = req.query.shipmentId || null;
    let linkedOrder = null;
    let raw;

    if (orderId) {
      const result = await pool.query(
        `SELECT id, fulfillment_type, payment_method, payment_status, order_status, fulfill_status, shiprocket_awb, shiprocket_shipment_id
         FROM orders
         WHERE id = $1
         LIMIT 1`,
        [orderId]
      );
      linkedOrder = result.rows[0] || null;
      if (!linkedOrder) return res.status(404).json({ error: 'Order not found' });
      if (linkedOrder.fulfillment_type !== 'DELIVERY') return res.status(422).json({ error: 'Tracking is available only for delivery orders' });

      if (linkedOrder.shiprocket_awb) raw = await trackByAwb(linkedOrder.shiprocket_awb);
      else if (linkedOrder.shiprocket_shipment_id) raw = await trackByShipmentId(linkedOrder.shiprocket_shipment_id);
      else return res.status(400).json({ error: 'Order has no Shiprocket identifiers' });
    } else if (awb) {
      raw = await trackByAwb(awb);
      const result = await pool.query(
        `SELECT id, fulfillment_type, payment_method, payment_status, order_status, fulfill_status, shiprocket_awb, shiprocket_shipment_id
         FROM orders
         WHERE shiprocket_awb = $1
         LIMIT 1`,
        [awb]
      );
      linkedOrder = result.rows[0] || null;
    } else if (shipmentId) {
      raw = await trackByShipmentId(shipmentId);
      const result = await pool.query(
        `SELECT id, fulfillment_type, payment_method, payment_status, order_status, fulfill_status, shiprocket_awb, shiprocket_shipment_id
         FROM orders
         WHERE shiprocket_shipment_id = $1
         LIMIT 1`,
        [shipmentId]
      );
      linkedOrder = result.rows[0] || null;
    } else {
      return res.status(400).json({ error: 'Provide orderId, awb or shipmentId' });
    }

    const tracking = normalize(raw);

    if (linkedOrder) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const newFulfillmentStatus = localFulfillmentStatus(tracking.status);
        const delivered = newFulfillmentStatus === 'COMPLETED';
        const cancelled = newFulfillmentStatus === 'CANCELLED';
        const newOrderStatus = delivered ? 'COMPLETED' : cancelled ? 'CANCELLED' : linkedOrder.order_status;
        const newPaymentStatus = delivered && linkedOrder.payment_method === 'COD' ? 'PAID' : linkedOrder.payment_status;

        await client.query(
          `UPDATE orders
           SET shiprocket_awb = COALESCE($2, shiprocket_awb),
               shiprocket_courier = COALESCE($3, shiprocket_courier),
               shiprocket_last_status = $4,
               shiprocket_last_update = NOW(),
               shiprocket_tracking_json = $5::jsonb,
               fulfill_status = $6,
               order_status = $7,
               payment_status = $8,
               updated_at = NOW()
           WHERE id = $1`,
          [
            linkedOrder.id,
            tracking.awb,
            tracking.courier,
            tracking.status,
            JSON.stringify({ normalized: tracking, raw }),
            newFulfillmentStatus,
            newOrderStatus,
            newPaymentStatus
          ]
        );

        if (linkedOrder.fulfill_status !== newFulfillmentStatus) {
          await recordOrderStatus(client, linkedOrder.id, 'FULFILLMENT', linkedOrder.fulfill_status, newFulfillmentStatus, tracking.status);
        }
        if (linkedOrder.order_status !== newOrderStatus) {
          await recordOrderStatus(client, linkedOrder.id, 'ORDER', linkedOrder.order_status, newOrderStatus, tracking.status);
        }
        if (linkedOrder.payment_status !== newPaymentStatus) {
          await recordOrderStatus(client, linkedOrder.id, 'PAYMENT', linkedOrder.payment_status, newPaymentStatus, 'COD delivery completed');
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    return res.json({ ok: true, orderId: linkedOrder?.id || null, ...tracking });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error), raw: error.response || null });
  }
});

module.exports = router;
