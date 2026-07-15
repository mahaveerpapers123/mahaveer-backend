const express = require('express');
const pool = require('../db');

const router = express.Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) {
  return String(value ?? '').trim();
}

function imageArray(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

router.post('/', async (req, res) => {
  try {
    const productId = text(req.body?.product_id || req.body?.productId);
    const userName = text(req.body?.user_name || req.body?.userName);
    const userEmail = text(req.body?.user_email || req.body?.userEmail) || null;
    const rating = Number(req.body?.rating);
    const title = text(req.body?.title) || null;
    const body = text(req.body?.body);
    const images = imageArray(req.body?.images);

    if (!uuidPattern.test(productId)) return res.status(400).json({ error: 'Invalid product_id' });
    if (!userName || !body) return res.status(400).json({ error: 'user_name and body are required' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Invalid rating' });

    const product = await pool.query(
      `SELECT id
       FROM "Products"
       WHERE id = $1 AND is_active = true AND deleted_at IS NULL
       LIMIT 1`,
      [productId]
    );
    if (!product.rowCount) return res.status(404).json({ error: 'Product not found' });

    const result = await pool.query(
      `INSERT INTO "ProductReviews" (
         product_id,
         user_name,
         user_email,
         rating,
         title,
         body,
         images,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
       RETURNING id, product_id, user_name, user_email, rating, title, body, images, helpful, created_at, updated_at`,
      [productId, userName, userEmail, rating, title, body, JSON.stringify(images)]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to create review', detail: String(error.message || error) });
  }
});

router.get('/', async (req, res) => {
  try {
    const productId = text(req.query.productId || req.query.product_id);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const params = [];
    let where = '';

    if (productId) {
      if (!uuidPattern.test(productId)) return res.status(400).json({ error: 'Invalid product_id' });
      params.push(productId);
      where = `WHERE product_id = $1`;
    }

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT id, product_id, user_name, user_email, rating, title, body, images, helpful, created_at, updated_at
       FROM "ProductReviews"
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params
    );

    const summary = productId
      ? await pool.query(
          `SELECT COUNT(*)::int AS total, COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS average_rating
           FROM "ProductReviews"
           WHERE product_id = $1`,
          [productId]
        )
      : null;

    return res.json({ reviews: result.rows, summary: summary?.rows[0] || null });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch reviews', detail: String(error.message || error) });
  }
});

router.patch('/:id/helpful', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE "ProductReviews"
       SET helpful = helpful + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING id, helpful`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Review not found' });
    return res.json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update helpful count', detail: String(error.message || error) });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM "ProductReviews" WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Review not found' });
    return res.json({ message: 'Review deleted' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete review', detail: String(error.message || error) });
  }
});

module.exports = router;
