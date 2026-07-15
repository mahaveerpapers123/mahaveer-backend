const express = require('express');
const pool = require('../db');

const router = express.Router();

function text(value) {
  return String(value ?? '').trim();
}

function leadingSlash(value) {
  const normalized = `/${text(value)}`.replace(/\/{2,}/g, '/');
  return normalized === '/' ? '' : normalized;
}

function slugPart(value) {
  return text(value)
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function uniqueSlug(client, desired, excludeId = null) {
  const base = leadingSlash(desired);
  let candidate = base;
  let suffix = 1;

  while (true) {
    const result = await client.query(
      `SELECT id
       FROM "NavLinks"
       WHERE LOWER(slug) = LOWER($1)
         AND ($2::uuid IS NULL OR id <> $2)
       LIMIT 1`,
      [candidate, excludeId]
    );
    if (!result.rowCount) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

router.get('/', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, parent_id, label, slug, display_order, published
       FROM "NavLinks"
       WHERE published = true
       ORDER BY parent_id NULLS FIRST, display_order, label`
    );

    const map = new Map();
    for (const row of result.rows) {
      map.set(row.id, {
        id: row.id,
        parentId: row.parent_id,
        title: row.label,
        path: row.parent_id ? row.slug.split('/').filter(Boolean).pop() : row.slug,
        fullPath: row.slug,
        type: 'category',
        slugKey: row.slug.replace(/^\//, '').split('/').join('-'),
        order: row.display_order,
        submenu: []
      });
    }

    const menu = [];
    for (const row of result.rows) {
      const node = map.get(row.id);
      const parent = row.parent_id ? map.get(row.parent_id) : null;
      if (parent) parent.submenu.push(node);
      else menu.push(node);
    }

    const clean = (node) => {
      if (!node.submenu.length) delete node.submenu;
      else node.submenu.forEach(clean);
      return node;
    };

    res.setHeader('Cache-Control', 'no-store');
    return res.json(menu.map(clean));
  } catch (error) {
    return res.status(500).json({ error: 'DB query failed', detail: String(error.message || error) });
  }
});

router.get('/flat', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, parent_id, label, slug, display_order, published, created_at
       FROM "NavLinks"
       ORDER BY parent_id NULLS FIRST, display_order, label`
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.post('/', async (req, res) => {
  const root = req.body || {};
  if (!text(root.title || root.label)) return res.status(400).json({ error: 'title is required' });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const insertNode = async (item, parentId, parentSlug, defaultOrder) => {
      const label = text(item.title || item.label);
      if (!label) throw new Error('Every category requires a title');
      const part = slugPart(item.path || item.slug || label);
      if (!part) throw new Error(`Invalid category path for ${label}`);
      const desired = parentSlug ? `${parentSlug}/${part}` : `/${part}`;
      const slug = await uniqueSlug(client, desired);
      const result = await client.query(
        `INSERT INTO "NavLinks" (label, slug, display_order, parent_id, published, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [label, slug, Number(item.order ?? item.display_order ?? defaultOrder ?? 1), parentId, item.published !== false]
      );

      const node = result.rows[0];
      const children = Array.isArray(item.submenu) ? item.submenu : Array.isArray(item.children) ? item.children : [];
      for (let index = 0; index < children.length; index += 1) {
        await insertNode(children[index], node.id, node.slug, index + 1);
      }
      return node;
    };

    const inserted = await insertNode(root, null, '', 1);
    await client.query('COMMIT');
    return res.status(201).json({ message: 'Menu saved', item: inserted });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Insert failed', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.post('/add-category-slug', async (req, res) => {
  const client = await pool.connect();

  try {
    const label = text(req.body?.label);
    const leaf = slugPart(req.body?.category_slug || label);
    const parentSlugInput = text(req.body?.parent_slug);
    if (!label || !leaf) return res.status(400).json({ error: 'Category slug and label are required' });

    await client.query('BEGIN');
    let parentId = null;
    let parentSlug = '';

    if (parentSlugInput) {
      const parent = await client.query(
        `SELECT id, slug
         FROM "NavLinks"
         WHERE LOWER(REGEXP_REPLACE(REPLACE(slug, '/', '-'), '^-+', '')) = LOWER($1)
            OR LOWER(REGEXP_REPLACE(slug, '^/', '')) = LOWER($1)
         LIMIT 1`,
        [parentSlugInput.replace(/^\/+/, '')]
      );
      if (!parent.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Parent category not found' });
      }
      parentId = parent.rows[0].id;
      parentSlug = parent.rows[0].slug;
    }

    const desired = parentSlug ? `${parentSlug}/${leaf}` : `/${leaf}`;
    const slug = await uniqueSlug(client, desired);
    const result = await client.query(
      `INSERT INTO "NavLinks" (label, slug, display_order, parent_id, published, created_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       RETURNING *`,
      [label, slug, Number(req.body?.display_order || 1), parentId]
    );

    await client.query('COMMIT');
    return res.status(201).json({ message: 'New category added successfully', item: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Error occurred while adding category slug', detail: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT * FROM "NavLinks" WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Category not found' });
    }

    const row = current.rows[0];
    const label = text(req.body?.label || req.body?.title) || row.label;
    const parentId = req.body?.parent_id === undefined ? row.parent_id : req.body.parent_id || null;
    let parentSlug = '';

    if (parentId) {
      if (String(parentId) === String(row.id)) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'Category cannot be its own parent' });
      }
      const parent = await client.query(`SELECT slug FROM "NavLinks" WHERE id = $1 LIMIT 1`, [parentId]);
      if (!parent.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Parent category not found' });
      }
      parentSlug = parent.rows[0].slug;
    }

    const part = slugPart(req.body?.path || req.body?.slug || row.slug.split('/').filter(Boolean).pop() || label);
    const slug = await uniqueSlug(client, parentSlug ? `${parentSlug}/${part}` : `/${part}`, row.id);

    const result = await client.query(
      `UPDATE "NavLinks"
       SET label = $2,
           slug = $3,
           parent_id = $4,
           display_order = $5,
           published = $6
       WHERE id = $1
       RETURNING *`,
      [
        row.id,
        label,
        slug,
        parentId,
        Number(req.body?.display_order ?? req.body?.order ?? row.display_order ?? 1),
        req.body?.published === undefined ? row.published : req.body.published === true
      ]
    );

    if (slug !== row.slug) {
      await client.query(
        `WITH RECURSIVE descendants AS (
           SELECT id, slug FROM "NavLinks" WHERE parent_id = $1
           UNION ALL
           SELECT child.id, child.slug
           FROM "NavLinks" child
           JOIN descendants parent ON child.parent_id = parent.id
         )
         UPDATE "NavLinks" child
         SET slug = $2 || SUBSTRING(child.slug FROM CHAR_LENGTH($3) + 1)
         FROM descendants d
         WHERE child.id = d.id`,
        [row.id, slug, row.slug]
      );
    }

    await client.query('COMMIT');
    return res.json({ item: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: String(error.message || error) });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM "NavLinks" WHERE id = $1
         UNION ALL
         SELECT child.id
         FROM "NavLinks" child
         JOIN tree parent ON child.parent_id = parent.id
       )
       UPDATE "NavLinks"
       SET published = false
       WHERE id IN (SELECT id FROM tree)
       RETURNING id`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Category not found' });
    return res.json({ message: 'Category unpublished', affected: result.rowCount });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

module.exports = router;
