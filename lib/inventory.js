const crypto = require('crypto');

const INVENTORY_ENABLED = String(process.env.INVENTORY_ENFORCEMENT_ENABLED || 'false').toLowerCase() === 'true';

function toQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(3));
}

function hashPickupCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function generatePickupCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function getLocationByCode(client, code = 'MAIN-SHOP') {
  const result = await client.query(
    `SELECT id, name, code, location_type, pickup_enabled, is_active
     FROM inventory_locations
     WHERE code = $1
     LIMIT 1`,
    [String(code || 'MAIN-SHOP').trim().toUpperCase()]
  );
  return result.rows[0] || null;
}

async function ensureInventoryRows(client, productIds, locationId) {
  if (!Array.isArray(productIds) || !productIds.length || !locationId) return;
  await client.query(
    `INSERT INTO product_inventory (product_id, location_id, on_hand, reserved)
     SELECT product_id, $2::uuid, 0, 0
     FROM unnest($1::uuid[]) AS ids(product_id)
     ON CONFLICT (product_id, location_id) DO NOTHING`,
    [productIds, locationId]
  );
}

async function reserveOrderItems(client, { orderId, locationId, items, expiresAt }) {
  if (!INVENTORY_ENABLED) return { enabled: false, reservations: [] };
  const reservations = [];

  for (const item of items) {
    const quantity = toQuantity(item.quantity);
    if (!quantity) throw new Error(`Invalid quantity for product ${item.productId}`);

    const inventoryResult = await client.query(
      `SELECT product_id, location_id, on_hand, reserved
       FROM product_inventory
       WHERE product_id = $1 AND location_id = $2
       FOR UPDATE`,
      [item.productId, locationId]
    );

    const inventory = inventoryResult.rows[0];
    if (!inventory) throw new Error(`Inventory row missing for product ${item.productId}`);

    const onHand = Number(inventory.on_hand || 0);
    const reserved = Number(inventory.reserved || 0);
    const available = onHand - reserved;

    if (available < quantity) {
      const error = new Error(`Insufficient stock for ${item.productName || item.productId}`);
      error.code = 'INSUFFICIENT_STOCK';
      error.details = {
        product_id: item.productId,
        requested: quantity,
        available
      };
      throw error;
    }

    await client.query(
      `UPDATE product_inventory
       SET reserved = reserved + $3, updated_at = NOW()
       WHERE product_id = $1 AND location_id = $2`,
      [item.productId, locationId, quantity]
    );

    const reservation = await client.query(
      `INSERT INTO stock_reservations (
         order_id,
         order_item_id,
         product_id,
         location_id,
         quantity,
         status,
         expires_at,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, NOW(), NOW())
       ON CONFLICT (order_item_id)
       DO UPDATE SET
         product_id = EXCLUDED.product_id,
         location_id = EXCLUDED.location_id,
         quantity = EXCLUDED.quantity,
         status = 'ACTIVE',
         expires_at = EXCLUDED.expires_at,
         committed_at = NULL,
         released_at = NULL,
         updated_at = NOW()
       RETURNING *`,
      [orderId, item.orderItemId, item.productId, locationId, quantity, expiresAt]
    );

    reservations.push(reservation.rows[0]);
  }

  return { enabled: true, reservations };
}

async function commitOrderReservations(client, orderId, reason = 'Order committed', createdBy = null) {
  const reservationsResult = await client.query(
    `SELECT id, order_item_id, product_id, location_id, quantity
     FROM stock_reservations
     WHERE order_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at
     FOR UPDATE`,
    [orderId]
  );

  let committed = 0;

  for (const reservation of reservationsResult.rows) {
    const inventoryResult = await client.query(
      `SELECT on_hand, reserved
       FROM product_inventory
       WHERE product_id = $1 AND location_id = $2
       FOR UPDATE`,
      [reservation.product_id, reservation.location_id]
    );

    const inventory = inventoryResult.rows[0];
    if (!inventory) throw new Error(`Inventory row missing for product ${reservation.product_id}`);

    const quantity = Number(reservation.quantity || 0);
    const stockBefore = Number(inventory.on_hand || 0);
    const reservedBefore = Number(inventory.reserved || 0);

    if (stockBefore < quantity || reservedBefore < quantity) {
      throw new Error(`Inventory mismatch for product ${reservation.product_id}`);
    }

    const stockAfter = Number((stockBefore - quantity).toFixed(3));

    await client.query(
      `UPDATE product_inventory
       SET on_hand = on_hand - $3,
           reserved = reserved - $3,
           updated_at = NOW()
       WHERE product_id = $1 AND location_id = $2`,
      [reservation.product_id, reservation.location_id, quantity]
    );

    await client.query(
      `INSERT INTO inventory_movements (
         product_id,
         location_id,
         order_id,
         order_item_id,
         movement_type,
         quantity_delta,
         stock_before,
         stock_after,
         reason,
         reference,
         created_by,
         created_at
       ) VALUES ($1, $2, $3, $4, 'SALE', $5, $6, $7, $8, $9, $10, NOW())`,
      [
        reservation.product_id,
        reservation.location_id,
        orderId,
        reservation.order_item_id,
        -quantity,
        stockBefore,
        stockAfter,
        reason,
        String(orderId),
        createdBy
      ]
    );

    await client.query(
      `UPDATE stock_reservations
       SET status = 'COMMITTED', committed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [reservation.id]
    );

    committed += 1;
  }

  return { committed };
}

async function releaseOrderReservations(client, orderId, reason = 'Reservation released') {
  const reservationsResult = await client.query(
    `SELECT id, product_id, location_id, quantity
     FROM stock_reservations
     WHERE order_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at
     FOR UPDATE`,
    [orderId]
  );

  let released = 0;

  for (const reservation of reservationsResult.rows) {
    const quantity = Number(reservation.quantity || 0);

    await client.query(
      `UPDATE product_inventory
       SET reserved = GREATEST(reserved - $3, 0), updated_at = NOW()
       WHERE product_id = $1 AND location_id = $2`,
      [reservation.product_id, reservation.location_id, quantity]
    );

    await client.query(
      `UPDATE stock_reservations
       SET status = 'RELEASED', released_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [reservation.id]
    );

    released += 1;
  }

  if (released > 0) {
    await client.query(
      `INSERT INTO order_status_history (order_id, status_type, old_status, new_status, note, created_at)
       VALUES ($1, 'FULFILLMENT', 'RESERVED', 'RELEASED', $2, NOW())`,
      [orderId, reason]
    );
  }

  return { released };
}


async function restoreCommittedOrderStock(client, orderId, reason = 'Order cancelled after stock deduction', createdBy = null) {
  const reservationsResult = await client.query(
    `SELECT id, order_item_id, product_id, location_id, quantity
     FROM stock_reservations
     WHERE order_id = $1 AND status = 'COMMITTED'
     ORDER BY created_at
     FOR UPDATE`,
    [orderId]
  );

  let restored = 0;

  for (const reservation of reservationsResult.rows) {
    const existingMovement = await client.query(
      `SELECT id
       FROM inventory_movements
       WHERE order_id = $1
         AND order_item_id = $2
         AND movement_type = 'ORDER_CANCELLED'
       LIMIT 1`,
      [orderId, reservation.order_item_id]
    );

    if (existingMovement.rowCount) continue;

    const inventoryResult = await client.query(
      `SELECT on_hand, reserved
       FROM product_inventory
       WHERE product_id = $1 AND location_id = $2
       FOR UPDATE`,
      [reservation.product_id, reservation.location_id]
    );

    const inventory = inventoryResult.rows[0];
    if (!inventory) throw new Error(`Inventory row missing for product ${reservation.product_id}`);

    const quantity = Number(reservation.quantity || 0);
    const stockBefore = Number(inventory.on_hand || 0);
    const stockAfter = Number((stockBefore + quantity).toFixed(3));

    await client.query(
      `UPDATE product_inventory
       SET on_hand = on_hand + $3, updated_at = NOW()
       WHERE product_id = $1 AND location_id = $2`,
      [reservation.product_id, reservation.location_id, quantity]
    );

    await client.query(
      `INSERT INTO inventory_movements (
         product_id,
         location_id,
         order_id,
         order_item_id,
         movement_type,
         quantity_delta,
         stock_before,
         stock_after,
         reason,
         reference,
         created_by,
         created_at
       ) VALUES ($1, $2, $3, $4, 'ORDER_CANCELLED', $5, $6, $7, $8, $9, $10, NOW())`,
      [
        reservation.product_id,
        reservation.location_id,
        orderId,
        reservation.order_item_id,
        quantity,
        stockBefore,
        stockAfter,
        reason,
        String(orderId),
        createdBy
      ]
    );

    restored += 1;
  }

  return { restored };
}

async function expireReservations(client) {
  const reservationsResult = await client.query(
    `SELECT order_id
     FROM stock_reservations
     WHERE status = 'ACTIVE'
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
     FOR UPDATE`
  );
  const orderIds = [...new Set(reservationsResult.rows.map((row) => row.order_id))];

  let expiredOrders = 0;
  let expiredReservations = 0;

  for (const orderId of orderIds) {
    const result = await releaseOrderReservations(client, orderId, 'Reservation expired');
    await client.query(
      `UPDATE stock_reservations
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE order_id = $1 AND status = 'RELEASED' AND expires_at <= NOW()`,
      [orderId]
    );
    await client.query(
      `UPDATE orders
       SET order_status = CASE WHEN payment_status = 'PAID' THEN order_status ELSE 'EXPIRED' END,
           updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    );
    expiredOrders += 1;
    expiredReservations += result.released;
  }

  return { expiredOrders, expiredReservations };
}

async function recordOrderStatus(client, orderId, statusType, oldStatus, newStatus, note = null, changedBy = null) {
  await client.query(
    `INSERT INTO order_status_history (
       order_id,
       status_type,
       old_status,
       new_status,
       note,
       changed_by,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [orderId, statusType, oldStatus || null, newStatus, note || null, changedBy || null]
  );
}

module.exports = {
  INVENTORY_ENABLED,
  generatePickupCode,
  hashPickupCode,
  getLocationByCode,
  ensureInventoryRows,
  reserveOrderItems,
  commitOrderReservations,
  releaseOrderReservations,
  restoreCommittedOrderStock,
  expireReservations,
  recordOrderStatus
};
