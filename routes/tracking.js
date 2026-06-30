const express = require("express");
const pool = require("../db");
const { trackByAwb, trackByShipmentId } = require("../lib/shiprocket");

const router = express.Router();

function normalize(resp) {
  const trackingData = resp?.tracking_data || {};
  const tracks = Array.isArray(trackingData?.shipment_track)
    ? trackingData.shipment_track
    : trackingData?.shipment_track
      ? [trackingData.shipment_track]
      : [];
  const activities = Array.isArray(trackingData?.shipment_track_activities)
    ? trackingData.shipment_track_activities
    : [];
  const primary = tracks[0] || {};
  const status = primary.current_status || trackingData.current_status || trackingData.shipment_status_label || trackingData.shipment_status || trackingData.track_status || "Unknown";
  const awb = primary.awb_code || trackingData.awb_code || resp?.awb_code || null;
  const courier = primary.courier_name || trackingData.courier_name || resp?.courier_name || null;
  return {
    status,
    awb,
    courier,
    checkpoints: activities.map((item) => ({
      date: item.date || item.activity_date || null,
      activity: item.activity || item.status || item["sr-status"] || item.location || "",
      location: item.location || item.delivered_to || item.destination || ""
    }))
  };
}

router.get("/", async (req, res) => {
  try {
    const { orderId, awb, shipmentId } = req.query;
    let raw = null;
    let linkedOrderId = orderId || null;

    if (awb) {
      raw = await trackByAwb(awb);
    } else if (shipmentId) {
      raw = await trackByShipmentId(shipmentId);
    } else if (orderId) {
      const q = await pool.query(
        `
        SELECT shiprocket_awb, shiprocket_shipment_id
        FROM orders
        WHERE id = $1
        LIMIT 1
        `,
        [orderId]
      );
      const row = q.rows[0];
      if (!row) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (row.shiprocket_awb) {
        raw = await trackByAwb(row.shiprocket_awb);
      } else if (row.shiprocket_shipment_id) {
        raw = await trackByShipmentId(row.shiprocket_shipment_id);
      } else {
        return res.status(400).json({ error: "Order has no Shiprocket identifiers" });
      }
    } else {
      return res.status(400).json({ error: "Provide orderId or awb or shipmentId" });
    }

    const normalized = normalize(raw);

    if (linkedOrderId) {
      await pool.query(
        `
        UPDATE orders
        SET shiprocket_last_status = $2,
            shiprocket_last_update = NOW(),
            shiprocket_tracking_json = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
        `,
        [linkedOrderId, String(normalized.status), JSON.stringify({ normalized, raw })]
      );
    }

    res.json({ ok: true, ...normalized });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;