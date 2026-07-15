const express = require('express');
const pool = require('../db');

const router = express.Router();

function text(value) {
  return String(value ?? '').trim();
}

function booleanValue(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = text(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return fallback;
}

function normalizeAlias(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

router.get('/', async (req, res) => {
  try {
    const query = text(req.query.query || req.query.q);
    const activeOnly = booleanValue(req.query.activeOnly, true);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 1), 1000);
    const params = [];
    const where = [];

    if (activeOnly) where.push('b.is_active = true');

    if (query) {
      params.push(`%${query}%`);
      where.push(`(
        b.name ILIKE $${params.length}
        OR b.slug ILIKE $${params.length}
        OR EXISTS (
          SELECT 1
          FROM brand_aliases alias_search
          WHERE alias_search.brand_id = b.id
            AND alias_search.alias ILIKE $${params.length}
        )
      )`);
    }

    params.push(limit);

    const result = await pool.query(
      `SELECT
         b.id,
         b.name,
         b.slug,
         b.is_active,
         COALESCE(
           jsonb_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.id IS NOT NULL),
           '[]'::jsonb
         ) AS aliases
       FROM brands b
       LEFT JOIN brand_aliases a ON a.brand_id = b.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY b.id
       ORDER BY b.name
       LIMIT $${params.length}`,
      params
    );

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ total: result.rows.length, brands: result.rows });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.get('/resolve', async (req, res) => {
  try {
    const value = text(req.query.value || req.query.brand || req.query.name);

    if (!value) {
      return res.status(400).json({ error: 'value is required' });
    }

    const normalizedAlias = normalizeAlias(value);

    const result = await pool.query(
      `SELECT DISTINCT
         b.id,
         b.name,
         b.slug,
         b.is_active
       FROM brands b
       LEFT JOIN brand_aliases a ON a.brand_id = b.id
       WHERE b.is_active = true
         AND (
           LOWER(BTRIM(b.name)) = LOWER(BTRIM($1))
           OR LOWER(BTRIM(b.slug)) = LOWER(BTRIM($2))
           OR a.normalized_alias = $3
         )
       LIMIT 1`,
      [value, value, normalizedAlias]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    return res.json({ brand: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         b.id,
         b.name,
         b.slug,
         b.is_active,
         COALESCE(
           jsonb_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.id IS NOT NULL),
           '[]'::jsonb
         ) AS aliases
       FROM brands b
       LEFT JOIN brand_aliases a ON a.brand_id = b.id
       WHERE b.id = $1
       GROUP BY b.id
       LIMIT 1`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    return res.json({ brand: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

module.exports = router;
