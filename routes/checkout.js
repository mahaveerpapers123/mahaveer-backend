const express = require("express");
const router = express.Router();
const db = require("../db");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMinor(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function getShippingChargeMinor(subtotalMinor) {
  if (!Number.isFinite(subtotalMinor) || subtotalMinor <= 0) return 0;
  return subtotalMinor < 100000 ? 7500 : 0;
}

router.post("/", async (req, res) => {
  const client = await db.connect();

  try {
    const { billing = {}, shipping = {}, payment = {}, items = [] } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No items in order" });
    }

    await client.query("BEGIN");

    const normalizedItems = items.map((item) => {
      const quantity = Math.max(1, Number(item.quantity || item.qty || 1));

      let unitPriceMinor = Number(item.unit_price_minor);

      if (!Number.isFinite(unitPriceMinor) || unitPriceMinor <= 0) {
        const rupeePrice = Number(item.mahaveer_price ?? item.price ?? item.mrp ?? 0);
        unitPriceMinor = Number.isFinite(rupeePrice) ? toMinor(rupeePrice) : 0;
      }

      const subtotalMinor = quantity * unitPriceMinor;

      return {
        product_id: item.product_id || item.id || null,
        product_name: String(item.product_name || item.name || "Item"),
        unit_price_minor: unitPriceMinor,
        quantity,
        subtotal_minor: subtotalMinor,
        image_url:
          item.image_url ||
          item.image ||
          (Array.isArray(item.images) ? item.images[0] : null) ||
          null,
        height: num(item.height),
        width: num(item.width),
        length: num(item.length),
        weight: num(item.weight),
        mahaveer_price: num(item.mahaveer_price ?? item.price),
        hsn_percentage: num(item.hsn_percentage),
        mrp: num(item.mrp)
      };
    });

    const itemsSubtotalMinor = normalizedItems.reduce(
      (sum, item) => sum + item.subtotal_minor,
      0
    );

    const shippingChargeMinor = getShippingChargeMinor(itemsSubtotalMinor);
    const finalTotalMinor = itemsSubtotalMinor + shippingChargeMinor;

    const shippingAddress = {
      name: shipping?.name || billing?.name || null,
      line1: shipping?.address?.line1 || shipping?.line1 || null,
      line2: shipping?.address?.line2 || shipping?.line2 || null,
      city: shipping?.address?.city || shipping?.city || null,
      state: shipping?.address?.state || shipping?.state || null,
      postal_code: shipping?.address?.postal_code || shipping?.postal_code || null,
      country: shipping?.address?.country || shipping?.country || "India",
      phone: shipping?.address?.phone || shipping?.phone || billing?.phone || null,
      shipping_charge: shippingChargeMinor / 100,
      shipping_charge_minor: shippingChargeMinor
    };

    const billingAddress = {
      name: billing?.name || null,
      email: billing?.email || null,
      line1: billing?.address?.line1 || billing?.line1 || null,
      line2: billing?.address?.line2 || billing?.line2 || null,
      city: billing?.address?.city || billing?.city || null,
      state: billing?.address?.state || billing?.state || null,
      postal_code: billing?.address?.postal_code || billing?.postal_code || null,
      country: billing?.address?.country || billing?.country || "India",
      phone: billing?.address?.phone || billing?.phone || null,
      items_subtotal: itemsSubtotalMinor / 100,
      items_subtotal_minor: itemsSubtotalMinor,
      shipping_charge: shippingChargeMinor / 100,
      shipping_charge_minor: shippingChargeMinor,
      total: finalTotalMinor / 100,
      total_minor: finalTotalMinor
    };

    const paymentMethod = String(payment?.method || "COD").toUpperCase();

    const orderInsert = await client.query(
      `
      INSERT INTO orders (
        email,
        total_amount,
        currency,
        payment_status,
        order_status,
        fulfill_status,
        shipping_addr,
        billing_addr
      )
      VALUES (
        $1,
        $2,
        'INR',
        'PENDING',
        'PENDING',
        'NOT_PACKED',
        $3::jsonb,
        $4::jsonb
      )
      RETURNING id, total_amount
      `,
      [
        billing?.email || null,
        finalTotalMinor,
        JSON.stringify(shippingAddress),
        JSON.stringify(billingAddress)
      ]
    );

    const orderId = orderInsert.rows[0].id;

    const columns = [
      "order_id",
      "product_id",
      "product_name",
      "unit_price_minor",
      "quantity",
      "subtotal_minor",
      "image_url",
      "height",
      "width",
      "length",
      "weight",
      "mahaveer_price",
      "hsn_percentage",
      "mrp"
    ];

    const values = [];

    const placeholders = normalizedItems
      .map((item, index) => {
        const base = index * columns.length;

        values.push(
          orderId,
          item.product_id,
          item.product_name,
          item.unit_price_minor,
          item.quantity,
          item.subtotal_minor,
          item.image_url,
          item.height,
          item.width,
          item.length,
          item.weight,
          item.mahaveer_price,
          item.hsn_percentage,
          item.mrp
        );

        return `(${columns.map((_, columnIndex) => `$${base + columnIndex + 1}`).join(", ")})`;
      })
      .join(", ");

    await client.query(
      `
      INSERT INTO order_items
        (${columns.join(", ")})
      VALUES ${placeholders}
      `,
      values
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "Order placed successfully",
      orderId,
      payment_method: paymentMethod,
      subtotal: itemsSubtotalMinor / 100,
      shipping_charge: shippingChargeMinor / 100,
      total: finalTotalMinor / 100,
      total_amount: finalTotalMinor
    });
  } catch (err) {
    await client.query("ROLLBACK");

    res.status(500).json({
      message: "Server error",
      error: err.message
    });
  } finally {
    client.release();
  }
});

module.exports = router;