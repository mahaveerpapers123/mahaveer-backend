const express = require('express');
const pool = require('../db');

const router = express.Router();

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return fallback;
}

router.get('/', async (req, res) => {
  try {
    const includeParents = booleanValue(req.query.includeParents, false);
    const leavesOnly = booleanValue(req.query.leavesOnly, false);
    const includeAll = booleanValue(req.query.includeAll, true);
    const query = String(req.query.query || req.query.q || '').trim();
    const params = [];
    const where = ['n.published = true'];

    if (!includeParents && !leavesOnly) {
      where.push('n.parent_id IS NULL');
    }

    if (leavesOnly) {
      where.push(`NOT EXISTS (
        SELECT 1
        FROM "NavLinks" child
        WHERE child.parent_id = n.id
          AND child.published = true
      )`);
    }

    if (query) {
      params.push(`%${query}%`);
      where.push(`(n.label ILIKE $${params.length} OR n.slug ILIKE $${params.length})`);
    }

    const result = await pool.query(
      `SELECT
         n.id,
         n.parent_id,
         n.label,
         REGEXP_REPLACE(n.slug, '^/', '') AS value,
         REGEXP_REPLACE(n.slug, '^/', '') AS slug,
         n.display_order,
         n.published
       FROM "NavLinks" n
       WHERE ${where.join(' AND ')}
       ORDER BY n.parent_id NULLS FIRST, n.display_order NULLS LAST, n.label`,
      params
    );

    const categories = includeAll
      ? [
          {
            id: null,
            parent_id: null,
            label: 'All Categories',
            value: 'all',
            slug: 'all',
            display_order: 0,
            published: true
          },
          ...result.rows
        ]
      : result.rows;

    res.setHeader('Cache-Control', 'no-store');
    return res.json(categories);
  } catch (error) {
    return res.status(500).json({
      error: 'Unable to load categories',
      detail: String(error.message || error)
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         parent_id,
         label,
         REGEXP_REPLACE(slug, '^/', '') AS value,
         REGEXP_REPLACE(slug, '^/', '') AS slug,
         display_order,
         published
       FROM "NavLinks"
       WHERE id = $1
       LIMIT 1`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Category not found' });
    }

    return res.json({ category: result.rows[0] });
  } catch (error) {
    return res.status(500).json({
      error: 'Unable to load category',
      detail: String(error.message || error)
    });
  }
});

module.exports = router;
