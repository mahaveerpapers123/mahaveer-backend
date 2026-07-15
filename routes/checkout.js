const express = require('express');
const pool = require('../db');
const {
  INVENTORY_ENABLED,
  generatePickupCode,
  hashPickupCode,
  getLocationByCode,
  ensureInventoryRows,
  reserveOrderItems,
  recordOrderStatus
} = require('../lib/inventory');

const router = express.Router();

function text(value) {
  return String(value ?? '').trim();
}

function positiveInteger(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function moneyMinor(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function shippingChargeMinor(subtotalMinor, fulfillmentType) {
  if (fulfillmentType === 'PICKUP') return 0;
  if (!Number.isFinite(subtotalMinor) || subtotalMinor <= 0) return 0;
  return subtotalMinor < 100000 ? 7500 : 0;
}

function normalizeFulfillment(value) {
  const normalized = text(value || 'DELIVERY').toUpperCase();
  return ['DELIVERY', 'PICKUP'].includes(normalized) ? normalized : null;
}

function normalizePayment(value, fulfillmentType) {
  const normalized = text(value || (fulfillmentType === 'PICKUP' ? 'PAY_AT_STORE' : 'COD')).toUpperCase();
  if (fulfillmentType === 'DELIVERY' && ['ONLINE', 'COD'].includes(normalized)) return normalized;
  if (fulfillmentType === 'PICKUP' && ['ONLINE', 'PAY_AT_STORE'].includes(normalized)) return normalized;
  return null;
}

function addressObject(source = {}, fallback = {}) {
  const address = source.address && typeof source.address === 'object' ? source.address : source;
  return {
    name: text(source.name || fallback.name) || null,
    email: text(source.email || fallback.email) || null,
    line1: text(address.line1 || address.address1) || null,
    line2: text(address.line2 || address.address2) || null,
    city: text(address.city) || null,
    state: text(address.state) || null,
    postal_code: text(address.postal_code || address.pincode || address.zip) || null,
    country: text(address.country || 'India') || 'India',
    phone: text(address.phone || source.phone || fallback.phone) || null
  };
}

function reservationExpiry(paymentMethod) {
  const minutes = paymentMethod === 'ONLINE'
    ? Number(process.env.ONLINE_RESERVATION_MINUTES || 30)
    : Number(process.env.OFFLINE_RESERVATION_MINUTES || 1440);
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
  return new Date(Date.now() + safeMinutes * 60 * 1000);
}

router.post('/', async (req, res) => {
  const client = await pool.connect();

  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const fulfillmentType = normalizeFulfillment(body.fulfillment_type || body.fulfillmentType);
    const paymentMethod = normalizePayment(body.payment?.method || body.payment_method || body.paymentMethod, fulfillmentType);
    const locationCode = text(body.location_code || body.locationCode || 'MAIN-SHOP').toUpperCase();
    const requestedUserId = body.user_id ?? body.userId ?? null;

    if (!items.length) return res.status(400).json({ error: 'No items in order' });
    if (!fulfillmentType) return res.status(400).json({ error: 'Invalid fulfillment type' });
    if (!paymentMethod) return res.status(400).json({ error: 'Invalid payment method for fulfillment type' });

    await client.query('BEGIN');

    const location = await getLocationByCode(client, locationCode);
    if (!location || !location.is_active) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory location not found or inactive' });
    }

    if (fulfillmentType === 'PICKUP' && !location.pickup_enabled) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Pickup is not enabled at this location' });
    }

    let user = null;
    if (requestedUserId !== null && requestedUserId !== undefined && requestedUserId !== '') {
      const userResult = await client.query(
        `SELECT id, name, email, phone, user_type, gst_number, gst_verified, is_active
         FROM "Users"
         WHERE id = $1
         LIMIT 1`,
        [requestedUserId]
      );
      user = userResult.rows[0] || null;
      if (!user || user.is_active === false) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Customer account not found or inactive' });
      }
    }

    const customerType = user?.user_type === 'b2b' && user?.gst_verified === true ? 'B2B' : 'B2C';
    if (!['B2C', 'B2B'].includes(customerType)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid customer type' });
    }

    const billing = addressObject(body.billing || {}, {
      name: user?.name,
      email: user?.email,
      phone: user?.phone
    });
    const shipping = addressObject(body.shipping || {}, billing);

    const email = text(user?.email || billing.email || body.email) || null;

    if (!email) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Customer email is required' });
    }

    if (fulfillmentType === 'DELIVERY') {
      const required = ['name', 'line1', 'city', 'state', 'postal_code', 'phone'];
      const missing = required.filter((field) => !shipping[field]);
      if (missing.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Missing shipping fields: ${missing.join(', ')}` });
      }
    }

    const normalizedItems = [];

    for (const rawItem of items) {
      const productId = rawItem.product_id || rawItem.productId || rawItem.id;
      const quantity = positiveInteger(rawItem.quantity || rawItem.qty || 1);

      if (!productId || !quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Every item requires product_id and a positive quantity' });
      }

      const productResult = await client.query(
        `SELECT
           p.id,
           p.sku,
           p.name,
           p.model_name,
           p.brand,
           p.category_slug,
           p.barcode,
           p.colour,
           p.hsn_code,
           p.hsn_percentage,
           p.mrp,
           p.mahaveer_price,
           p.discount_b2b,
           p.discount_b2c,
           p.weight,
           p.length,
           p.width,
           p.height,
           p.images,
           p.unit,
           p.pack_size,
           p.purchase_price,
           p.track_inventory,
           p.published,
           p.is_active,
           p.deleted_at,
           COALESCE(b.name, p.brand) AS brand_name
         FROM "Products" p
         LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.id = $1
         LIMIT 1`,
        [productId]
      );

      const product = productResult.rows[0];

      if (!product || !product.published || !product.is_active || product.deleted_at) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Product not available: ${productId}` });
      }

      const basePrice = Number(product.mahaveer_price || 0);
      const discount = customerType === 'B2B'
        ? clampPercent(product.discount_b2b)
        : clampPercent(product.discount_b2c);
      const unitPrice = Number((basePrice * (1 - discount / 100)).toFixed(2));
      const unitPriceMinor = moneyMinor(unitPrice);

      if (unitPriceMinor <= 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: `Invalid selling price for ${product.name}` });
      }

      const images = Array.isArray(product.images) ? product.images : [];

      normalizedItems.push({
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        barcode: product.barcode,
        brand: product.brand_name || product.brand,
        categorySlug: product.category_slug,
        modelName: product.model_name,
        colour: product.colour,
        hsnCode: product.hsn_code,
        hsnPercentage: product.hsn_percentage,
        mrp: product.mrp,
        mahaveerPrice: product.mahaveer_price,
        purchasePrice: product.purchase_price,
        unit: product.unit,
        packSize: product.pack_size,
        weight: product.weight,
        length: product.length,
        width: product.width,
        height: product.height,
        imageUrl: images[0] || null,
        quantity,
        unitPriceMinor,
        subtotalMinor: quantity * unitPriceMinor,
        trackInventory: product.track_inventory !== false
      });
    }

    const subtotalAmount = normalizedItems.reduce((sum, item) => sum + item.subtotalMinor, 0);
    const shippingAmount = shippingChargeMinor(subtotalAmount, fulfillmentType);
    const discountAmount = 0;
    const taxAmount = 0;
    const totalAmount = subtotalAmount + shippingAmount - discountAmount + taxAmount;
    const expiresAt = reservationExpiry(paymentMethod);
    const pickupCode = fulfillmentType === 'PICKUP' ? generatePickupCode() : null;
    const pickupCodeHash = pickupCode ? hashPickupCode(pickupCode) : null;

    const shippingAddress = fulfillmentType === 'DELIVERY'
      ? {
          ...shipping,
          shipping_charge: shippingAmount / 100,
          shipping_charge_minor: shippingAmount
        }
      : {
          pickup_location_id: location.id,
          pickup_location_name: location.name,
          pickup_location_code: location.code,
          customer_name: billing.name,
          customer_phone: billing.phone
        };

    const billingAddress = {
      ...billing,
      items_subtotal: subtotalAmount / 100,
      items_subtotal_minor: subtotalAmount,
      shipping_charge: shippingAmount / 100,
      shipping_charge_minor: shippingAmount,
      discount: discountAmount / 100,
      discount_minor: discountAmount,
      tax: taxAmount / 100,
      tax_minor: taxAmount,
      total: totalAmount / 100,
      total_minor: totalAmount,
      gst_number: customerType === 'B2B' ? user?.gst_number || body.gst_number || null : null
    };

    const orderResult = await client.query(
      `INSERT INTO orders (
         user_id,
         email,
         total_amount,
         currency,
         payment_status,
         order_status,
         fulfill_status,
         decision_status,
         billing_addr,
         shipping_addr,
         fulfillment_type,
         inventory_location_id,
         customer_type,
         order_channel,
         payment_method,
         subtotal_amount,
         shipping_amount,
         discount_amount,
         tax_amount,
         reserved_until,
         pickup_code_hash,
         pickup_expires_at,
         customer_notes,
         updated_at
       ) VALUES (
         $1, $2, $3, 'INR', 'PENDING', 'PENDING', 'NOT_PACKED', 'Pending',
         $4::jsonb, $5::jsonb, $6, $7, $8, 'WEBSITE', $9,
         $10, $11, $12, $13, $14, $15, $16, $17, NOW()
       )
       RETURNING *`,
      [
        user?.id || null,
        email,
        totalAmount,
        JSON.stringify(billingAddress),
        JSON.stringify(shippingAddress),
        fulfillmentType,
        location.id,
        customerType,
        paymentMethod,
        subtotalAmount,
        shippingAmount,
        discountAmount,
        taxAmount,
        expiresAt,
        pickupCodeHash,
        null,
        text(body.customer_notes || body.customerNotes) || null
      ]
    );

    const order = orderResult.rows[0];
    const reservationItems = [];

    for (const item of normalizedItems) {
      const itemResult = await client.query(
        `INSERT INTO order_items (
           order_id,
           product_id,
           product_name,
           unit_price_minor,
           quantity,
           subtotal_minor,
           image_url,
           height,
           width,
           length,
           weight,
           mahaveer_price,
           hsn_percentage,
           mrp,
           brand,
           category_slug,
           model_name,
           sku,
           barcode,
           hsn_code,
           unit,
           pack_size,
           purchase_price,
           inventory_location_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
         )
         RETURNING id`,
        [
          order.id,
          item.productId,
          item.productName,
          item.unitPriceMinor,
          item.quantity,
          item.subtotalMinor,
          item.imageUrl,
          item.height,
          item.width,
          item.length,
          item.weight,
          item.mahaveerPrice,
          item.hsnPercentage,
          item.mrp,
          item.brand,
          item.categorySlug,
          item.modelName,
          item.sku,
          item.barcode,
          item.hsnCode,
          item.unit,
          item.packSize,
          item.purchasePrice,
          location.id
        ]
      );

      if (item.trackInventory) {
        reservationItems.push({
          orderItemId: itemResult.rows[0].id,
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity
        });
      }
    }

    if (reservationItems.length) {
      await ensureInventoryRows(client, reservationItems.map((item) => item.productId), location.id);
      await reserveOrderItems(client, {
        orderId: order.id,
        locationId: location.id,
        items: reservationItems,
        expiresAt
      });
    }

    await recordOrderStatus(client, order.id, 'ORDER', null, 'PENDING', 'Order created');
    await recordOrderStatus(client, order.id, 'PAYMENT', null, 'PENDING', paymentMethod);
    await recordOrderStatus(
      client,
      order.id,
      'FULFILLMENT',
      null,
      INVENTORY_ENABLED && reservationItems.length ? 'RESERVED' : 'NOT_PACKED',
      fulfillmentType
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Order placed successfully',
      orderId: order.id,
      fulfillment_type: fulfillmentType,
      payment_method: paymentMethod,
      customer_type: customerType,
      inventory_enforced: INVENTORY_ENABLED,
      reservation_expires_at: expiresAt,
      pickup_code: pickupCode,
      subtotal: subtotalAmount / 100,
      shipping_charge: shippingAmount / 100,
      discount: discountAmount / 100,
      tax: taxAmount / 100,
      total: totalAmount / 100,
      total_amount: totalAmount
    });
  } catch (error) {
    await client.query('ROLLBACK');
    const status = error.code === 'INSUFFICIENT_STOCK' ? 409 : 500;
    return res.status(status).json({
      error: error.code === 'INSUFFICIENT_STOCK' ? 'Insufficient stock' : 'Checkout failed',
      detail: String(error.message || error),
      ...(error.details ? { details: error.details } : {})
    });
  } finally {
    client.release();
  }
});

module.exports = router;
