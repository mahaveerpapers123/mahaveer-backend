const express = require('express');
const pool = require('../db');
const {
  getLocationByCode,
  ensureInventoryRows,
  expireReservations
} = require('../lib/inventory');

const router = express.Router();

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveInt(value, fallback, max = 500) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

router.get('/locations', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, code, location_type, address, latitude, longitude, pickup_enabled, is_active, created_at, updated_at
       FROM inventory_locations
       ORDER BY is_active DESC, name`
    );
    return res.json({ locations: result.rows });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const params = [];
    const where = [];

    if (req.query.locationCode) {
      params.push(String(req.query.locationCode).trim().toUpperCase());
      where.push(`location_code = $${params.length}`);
    }

    if (req.query.status) {
      params.push(String(req.query.status).trim().toUpperCase());
      where.push(`stock_status = $${params.length}`);
    }

    if (req.query.query) {
      params.push(`%${String(req.query.query).trim()}%`);
      where.push(`(
        sku ILIKE $${params.length}
        OR name ILIKE $${params.length}
        OR COALESCE(model_name, '') ILIKE $${params.length}
        OR COALESCE(brand_name, '') ILIKE $${params.length}
      )`);
    }

    const page = positiveInt(req.query.page, 1, 100000);
    const limit = positiveInt(req.query.limit, 50, 500);
    const offset = (page - 1) * limit;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT *
       FROM inventory_summary
       ${whereSql}
       ORDER BY brand_name NULLS LAST, name, sku
       LIMIT $${dataParams.length - 1}
       OFFSET $${dataParams.length}`,
      dataParams
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM inventory_summary
       ${whereSql}`,
      params
    );

    return res.json({
      page,
      limit,
      total: countResult.rows[0].total,
      items: result.rows
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.get('/movements', async (req, res) => {
  try {
    const params = [];
    const where = [];

    if (req.query.productId) {
      params.push(req.query.productId);
      where.push(`m.product_id = $${params.length}`);
    }

    if (req.query.locationId) {
      params.push(req.query.locationId);
      where.push(`m.location_id = $${params.length}`);
    }

    if (req.query.orderId) {
      params.push(req.query.orderId);
      where.push(`m.order_id = $${params.length}`);
    }

    if (req.query.type) {
      params.push(String(req.query.type).trim().toUpperCase());
      where.push(`m.movement_type = $${params.length}`);
    }

    const page = positiveInt(req.query.page, 1, 100000);
    const limit = positiveInt(req.query.limit, 50, 500);
    const offset = (page - 1) * limit;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dataParams = [...params, limit, offset];

    const result = await pool.query(
      `SELECT
         m.*,
         p.sku,
         p.name AS product_name,
         l.name AS location_name,
         l.code AS location_code
       FROM inventory_movements m
       JOIN "Products" p ON p.id = m.product_id
       JOIN inventory_locations l ON l.id = m.location_id
       ${whereSql}
       ORDER BY m.created_at DESC
       LIMIT $${dataParams.length - 1}
       OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({ page, limit, items: result.rows });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.patch('/products/:productId/stock', async (req, res) => {
  const client = await pool.connect();

  try {
    const productId = req.params.productId;
    const locationCode = String(req.body?.locationCode || 'MAIN-SHOP').trim().toUpperCase();
    const absoluteOnHand = numberOrNull(req.body?.onHand);
    const quantityDelta = numberOrNull(req.body?.quantityDelta);
    const reorderLevel = numberOrNull(req.body?.reorderLevel);
    const purchasePrice = numberOrNull(req.body?.purchasePrice);
    const reason = String(req.body?.reason || 'Manual stock adjustment').trim();
    const createdBy = Number.isInteger(Number(req.body?.createdBy)) ? Number(req.body.createdBy) : null;

    if (absoluteOnHand === null && quantityDelta === null && reorderLevel === null && purchasePrice === null) {
      return res.status(400).json({ error: 'Provide onHand, quantityDelta, reorderLevel or purchasePrice' });
    }

    await client.query('BEGIN');

    const productResult = await client.query(
      `SELECT id, sku, name, reorder_level, purchase_price
       FROM "Products"
       WHERE id = $1 AND deleted_at IS NULL
       FOR UPDATE`,
      [productId]
    );

    if (!productResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const location = await getLocationByCode(client, locationCode);
    if (!location) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory location not found' });
    }

    await ensureInventoryRows(client, [productId], location.id);

    const inventoryResult = await client.query(
      `SELECT on_hand, reserved
       FROM product_inventory
       WHERE product_id = $1 AND location_id = $2
       FOR UPDATE`,
      [productId, location.id]
    );

    const inventory = inventoryResult.rows[0];
    const stockBefore = Number(inventory.on_hand || 0);
    const reserved = Number(inventory.reserved || 0);
    let stockAfter = stockBefore;

    if (absoluteOnHand !== null) stockAfter = absoluteOnHand;
    else if (quantityDelta !== null) stockAfter = stockBefore + quantityDelta;

    stockAfter = Number(stockAfter.toFixed(3));

    if (stockAfter < 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Stock cannot be negative' });
    }

    if (stockAfter < reserved) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Stock cannot be lower than reserved quantity', reserved });
    }

    if (stockAfter !== stockBefore) {
      const delta = Number((stockAfter - stockBefore).toFixed(3));
      const movementType = stockBefore === 0 && stockAfter > 0 ? 'OPENING_STOCK' : delta > 0 ? 'MANUAL_INCREASE' : 'MANUAL_DECREASE';

      await client.query(
        `UPDATE product_inventory
         SET on_hand = $3, updated_at = NOW()
         WHERE product_id = $1 AND location_id = $2`,
        [productId, location.id, stockAfter]
      );

      await client.query(
        `INSERT INTO inventory_movements (
           product_id,
           location_id,
           movement_type,
           quantity_delta,
           stock_before,
           stock_after,
           reason,
           reference,
           created_by,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [productId, location.id, movementType, delta, stockBefore, stockAfter, reason, req.body?.reference || null, createdBy]
      );
    }

    await client.query(
      `UPDATE "Products"
       SET reorder_level = COALESCE($2, reorder_level),
           purchase_price = COALESCE($3, purchase_price),
           updated_at = NOW()
       WHERE id = $1`,
      [productId, reorderLevel, purchasePrice]
    );

    await client.query('COMMIT');

    return res.json({
      product_id: productId,
      location_id: location.id,
      location_code: location.code,
      on_hand: stockAfter,
      reserved,
      available_stock: stockAfter - reserved,
      reorder_level: reorderLevel ?? productResult.rows[0].reorder_level,
      purchase_price: purchasePrice ?? productResult.rows[0].purchase_price
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.post('/opening-stock', async (req, res) => {
  const client = await pool.connect();

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const locationCode = String(req.body?.locationCode || 'MAIN-SHOP').trim().toUpperCase();
    const createdBy = Number.isInteger(Number(req.body?.createdBy)) ? Number(req.body.createdBy) : null;

    if (!items.length) return res.status(400).json({ error: 'items array is required' });

    await client.query('BEGIN');

    const location = await getLocationByCode(client, locationCode);
    if (!location) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory location not found' });
    }

    const updated = [];
    const errors = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {};
      const openingStock = numberOrNull(item.opening_stock ?? item.openingStock ?? item.on_hand);

      if (openingStock === null || openingStock < 0) {
        errors.push({ row: index + 1, sku: item.sku || null, error: 'Invalid opening stock' });
        continue;
      }

      const productResult = await client.query(
        `SELECT id, sku, name, purchase_price, reorder_level
         FROM "Products"
         WHERE ($1::uuid IS NOT NULL AND id = $1)
            OR ($2::text IS NOT NULL AND sku = $2)
         ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
         LIMIT 1
         FOR UPDATE`,
        [item.product_id || item.productId || null, item.sku || null]
      );

      if (!productResult.rowCount) {
        errors.push({ row: index + 1, sku: item.sku || null, error: 'Product not found' });
        continue;
      }

      const product = productResult.rows[0];
      await ensureInventoryRows(client, [product.id], location.id);

      const inventoryResult = await client.query(
        `SELECT on_hand, reserved
         FROM product_inventory
         WHERE product_id = $1 AND location_id = $2
         FOR UPDATE`,
        [product.id, location.id]
      );

      const inventory = inventoryResult.rows[0];
      const stockBefore = Number(inventory.on_hand || 0);
      const reserved = Number(inventory.reserved || 0);

      if (openingStock < reserved) {
        errors.push({ row: index + 1, sku: product.sku, error: 'Opening stock is lower than reserved stock' });
        continue;
      }

      const delta = Number((openingStock - stockBefore).toFixed(3));

      await client.query(
        `UPDATE product_inventory
         SET on_hand = $3, updated_at = NOW()
         WHERE product_id = $1 AND location_id = $2`,
        [product.id, location.id, openingStock]
      );

      if (delta !== 0) {
        await client.query(
          `INSERT INTO inventory_movements (
             product_id,
             location_id,
             movement_type,
             quantity_delta,
             stock_before,
             stock_after,
             reason,
             reference,
             created_by,
             created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
          [
            product.id,
            location.id,
            stockBefore === 0 ? 'OPENING_STOCK' : 'STOCK_CORRECTION',
            delta,
            stockBefore,
            openingStock,
            'Opening stock import',
            req.body?.reference || null,
            createdBy
          ]
        );
      }

      const purchasePrice = numberOrNull(item.purchase_price ?? item.purchasePrice);
      const reorderLevel = numberOrNull(item.reorder_level ?? item.reorderLevel);
      const unit = item.unit === undefined ? null : String(item.unit || '').trim() || null;
      const packSize = numberOrNull(item.pack_size ?? item.packSize);

      await client.query(
        `UPDATE "Products"
         SET purchase_price = COALESCE($2, purchase_price),
             reorder_level = COALESCE($3, reorder_level),
             unit = COALESCE($4, unit),
             pack_size = COALESCE($5, pack_size),
             updated_at = NOW()
         WHERE id = $1`,
        [product.id, purchasePrice, reorderLevel, unit, packSize]
      );

      updated.push({
        product_id: product.id,
        sku: product.sku,
        on_hand: openingStock,
        reserved,
        available_stock: openingStock - reserved
      });
    }

    await client.query('COMMIT');

    return res.status(errors.length ? 207 : 200).json({
      total: items.length,
      success: updated.length,
      failed: errors.length,
      updated,
      errors
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.post('/reservations/expire', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await expireReservations(client);
    await client.query('COMMIT');
    return res.json(result);
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: String(error.message || error) });
  } finally {
    client.release();
  }
});

module.exports = router;
