const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const includeParents = String(req.query.includeParents || 'false').toLowerCase() === 'true';
    const result = await pool.query(
      includeParents
        ? `SELECT id, parent_id, label, REGEXP_REPLACE(slug, '^/', '') AS value, display_order, published
           FROM "NavLinks"
           WHERE published = true
           ORDER BY parent_id NULLS FIRST, display_order, label`
        : `WITH leaves AS (
             SELECT n.id
             FROM "NavLinks" n
             WHERE n.published = true
               AND NOT EXISTS (
                 SELECT 1
                 FROM "NavLinks" child
                 WHERE child.parent_id = n.id AND child.published = true
               )
           )
           SELECT n.id, n.parent_id, n.label, REGEXP_REPLACE(n.slug, '^/', '') AS value, n.display_order, n.published
           FROM "NavLinks" n
           JOIN leaves l ON l.id = n.id
           ORDER BY n.label`
    );

    const options = [{ id: null, parent_id: null, label: 'All Categories', value: 'all', display_order: 0, published: true }, ...result.rows];
    res.setHeader('Cache-Control', 'no-store');
    return res.json(options);
  } catch (error) {
    return res.status(500).json({ error: 'Unable to load categories', detail: String(error.message || error) });
  }
});

module.exports = router;
