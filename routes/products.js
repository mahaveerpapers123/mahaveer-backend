const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const unzipper = require('unzipper');
const { v2: cloudinary } = require('cloudinary');
const pool = require('../db');
const { ensureInventoryRows, getLocationByCode } = require('../lib/inventory');

const router = express.Router();

function disableImportCache(req, res, next) {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];

  res.set({
    'Cache-Control':
      'private, no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store'
  });

  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 75 * 1024 * 1024,
    files: 20
  }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function text(value) {
  return String(value ?? '').trim();
}

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(
    String(value).replace(/,/g, '').trim()
  );

  return Number.isFinite(number) ? number : null;
}

function nonNegative(value, fallback = null) {
  const number = numberOrNull(value);

  if (number === null) {
    return fallback;
  }

  return number >= 0 ? number : fallback;
}

function clampPercent(value) {
  const number = numberOrNull(value);

  if (number === null) {
    return 0;
  }

  const percentage =
    number <= 1 && number > 0
      ? number * 100
      : number;

  return Math.max(
    0,
    Math.min(100, percentage)
  );
}

function booleanValue(value, fallback = true) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = text(value).toLowerCase();

  if (
    ['true', '1', 'yes', 'y'].includes(
      normalized
    )
  ) {
    return true;
  }

  if (
    ['false', '0', 'no', 'n'].includes(
      normalized
    )
  ) {
    return false;
  }

  return fallback;
}

function normalizeSlug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeAlias(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeImageKey(value) {
  return (
    text(value)
      .toLowerCase()
      .replace(/\.[^/.]+$/, '')
      .replace(/[\\/]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || null
  );
}

function sanitizeSku(value) {
  const normalized = text(value)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || null;
}

function sanitizeBarcode(value) {
  return (
    text(value)
      .replace(/[^0-9A-Za-z]/g, '')
      .slice(0, 64) || null
  );
}

function sanitizeHsn(value) {
  return (
    text(value)
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .slice(0, 8) || null
  );
}

function safeJson(value, fallback) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return fallback;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function imageUrlsFromBody(body) {
  const output = [];

  const add = (value) => {
    const url = text(value);

    if (url && !output.includes(url)) {
      output.push(url);
    }
  };

  if (Array.isArray(body.images)) {
    body.images.forEach(add);
  } else if (typeof body.images === 'string') {
    const parsed = safeJson(
      body.images,
      null
    );

    if (Array.isArray(parsed)) {
      parsed.forEach(add);
    } else {
      body.images.split(',').forEach(add);
    }
  }

  if (Array.isArray(body.imageUrls)) {
    body.imageUrls.forEach(add);
  } else if (
    typeof body.imageUrls === 'string'
  ) {
    const parsed = safeJson(
      body.imageUrls,
      null
    );

    if (Array.isArray(parsed)) {
      parsed.forEach(add);
    } else {
      body.imageUrls
        .split(',')
        .forEach(add);
    }
  }

  return output;
}

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

function uploadToCloudinary(
  buffer,
  publicId,
  folder = 'mahaveer-products'
) {
  return new Promise((resolve, reject) => {
    const stream =
      cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          overwrite: true,
          invalidate: true,
          resource_type: 'image'
        },
        (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        }
      );

    stream.end(buffer);
  });
}

async function resolveCloudinaryImage(
  key,
  folder = 'mahaveer-products'
) {
  if (!key || !cloudinaryReady()) {
    return null;
  }

  try {
    const result =
      await cloudinary.api.resource(
        `${folder}/${key}`,
        {
          resource_type: 'image'
        }
      );

    return result?.secure_url || null;
  } catch {
    return null;
  }
}

function imageIdentity(body) {
  const sku = sanitizeSku(body.sku);

  if (sku) {
    return normalizeImageKey(sku);
  }

  const explicit = normalizeImageKey(
    body.image_key || body.image_code
  );

  if (explicit) {
    return explicit;
  }

  const barcode = normalizeImageKey(
    body.barcode
  );

  const colour = normalizeImageKey(
    body.colour ?? body.color
  );

  if (barcode && colour) {
    return `${barcode}-${colour}`;
  }

  return barcode || null;
}

function validateProduct(body) {
  if (!text(body.name)) {
    return 'name is required';
  }

  if (!text(body.brand) && !body.brand_id) {
    return 'brand or brand_id is required';
  }

  if (
    !text(body.category_slug) &&
    !body.category_id
  ) {
    return 'category_slug or category_id is required';
  }

  const price = numberOrNull(
    body.mahaveer_price ?? body.price
  );

  const mrp = numberOrNull(body.mrp);

  if (price === null || price < 0) {
    return 'mahaveer_price must be a non-negative number';
  }

  if (mrp !== null && mrp < 0) {
    return 'mrp must be a non-negative number';
  }

  if (
    mrp !== null &&
    price !== null &&
    mrp < price
  ) {
    return 'mrp must be greater than or equal to mahaveer_price';
  }

  for (const field of [
    'weight',
    'length',
    'width',
    'height',
    'purchase_price',
    'pack_size',
    'reorder_level'
  ]) {
    const number = numberOrNull(body[field]);

    if (number !== null && number < 0) {
      return `${field} must be a non-negative number`;
    }
  }

  return null;
}

async function resolveBrand(client, body) {
  if (body.brand_id) {
    const result = await client.query(
      `SELECT
         id,
         name,
         slug
       FROM brands
       WHERE id = $1
         AND is_active = true
       LIMIT 1`,
      [body.brand_id]
    );

    if (!result.rowCount) {
      throw requestError(
        'Invalid or inactive brand_id',
        422
      );
    }

    return result.rows[0];
  }

  const rawName = text(body.brand);

  if (!rawName) {
    throw requestError(
      'brand or brand_id is required',
      422
    );
  }

  const exact = await client.query(
    `SELECT
       id,
       name,
       slug
     FROM brands
     WHERE is_active = true
       AND LOWER(BTRIM(name)) =
           LOWER(BTRIM($1))
     LIMIT 1`,
    [rawName]
  );

  if (exact.rowCount) {
    return exact.rows[0];
  }

  const slugMatch = await client.query(
    `SELECT
       id,
       name,
       slug
     FROM brands
     WHERE is_active = true
       AND LOWER(BTRIM(slug)) =
           LOWER(BTRIM($1))
     LIMIT 1`,
    [normalizeSlug(rawName)]
  );

  if (slugMatch.rowCount) {
    return slugMatch.rows[0];
  }

  const normalized =
    normalizeAlias(rawName);

  const alias = await client.query(
    `SELECT
       b.id,
       b.name,
       b.slug
     FROM brand_aliases a
     JOIN brands b
       ON b.id = a.brand_id
     WHERE a.normalized_alias = $1
       AND b.is_active = true
     LIMIT 1`,
    [normalized]
  );

  if (alias.rowCount) {
    return alias.rows[0];
  }

  throw requestError(
    `Unknown brand: ${rawName}`,
    422
  );
}

async function resolveCategory(client, body) {
  if (body.category_id) {
    const result = await client.query(
      `SELECT
         id,
         label,
         REGEXP_REPLACE(
           slug,
           '^/',
           ''
         ) AS slug
       FROM "NavLinks"
       WHERE id = $1
         AND published = true
       LIMIT 1`,
      [body.category_id]
    );

    if (!result.rowCount) {
      throw requestError(
        'Invalid or unpublished category_id',
        422
      );
    }

    return result.rows[0];
  }

  const raw = text(
    body.category_slug ||
      body.category
  );

  if (!raw) {
    throw requestError(
      'category_slug or category_id is required',
      422
    );
  }

  const normalized = normalizeSlug(
    raw.replace(/^\/+/, '')
  );

  const result = await client.query(
    `SELECT
       id,
       label,
       REGEXP_REPLACE(
         slug,
         '^/',
         ''
       ) AS slug
     FROM "NavLinks"
     WHERE published = true
       AND (
         LOWER(
           REGEXP_REPLACE(
             slug,
             '^/',
             ''
           )
         ) = LOWER($1)
         OR LOWER(
           BTRIM(
             REGEXP_REPLACE(
               slug,
               '^/',
               ''
             )
           )
         ) = LOWER($1)
         OR LOWER(
           BTRIM(
             BTRIM(
               REGEXP_REPLACE(
                 label,
                 '[^a-zA-Z0-9]+',
                 '-',
                 'g'
               ),
               '-'
             )
           )
         ) = LOWER($1)
       )
     ORDER BY
       parent_id NULLS FIRST,
       display_order,
       label
     LIMIT 1`,
    [normalized]
  );

  if (!result.rowCount) {
    throw requestError(
      `Unknown category: ${raw}`,
      422
    );
  }

  return result.rows[0];
}

function productValues(
  body,
  brand,
  category
) {
  const barcode = sanitizeBarcode(
    body.barcode
  );

  const colour =
    text(body.colour ?? body.color) ||
    null;

  const imageKey =
    normalizeImageKey(
      body.image_key ||
        body.image_code
    ) ||
    imageIdentity({
      ...body,
      barcode,
      colour
    });

  return {
    sku: sanitizeSku(body.sku),
    name: text(body.name),
    model_name:
      text(body.model_name) || null,
    brand:
      brand?.name || text(body.brand),
    brand_id: brand?.id || null,
    category_slug:
      category?.slug ||
      normalizeSlug(body.category_slug),
    category_id:
      category?.id || null,
    hsn_code: sanitizeHsn(
      body.hsn_code
    ),
    hsn_percentage: clampPercent(
      body.hsn_percentage
    ),
    mrp: nonNegative(body.mrp),
    mahaveer_price: nonNegative(
      body.mahaveer_price ?? body.price,
      0
    ),
    purchase_price: nonNegative(
      body.purchase_price
    ),
    discount_b2b: clampPercent(
      body.discount_b2b
    ),
    discount_b2c: clampPercent(
      body.discount_b2c
    ),
    weight: nonNegative(body.weight),
    length: nonNegative(body.length),
    width: nonNegative(body.width),
    height: nonNegative(body.height),
    description: text(
      body.description
    ),
    published: booleanValue(
      body.published,
      true
    ),
    barcode,
    colour,
    image_key: imageKey,
    unit: text(body.unit) || null,
    pack_size: nonNegative(
      body.pack_size
    ),
    reorder_level: nonNegative(
      body.reorder_level,
      0
    ),
    track_inventory: booleanValue(
      body.track_inventory,
      true
    ),
    is_active: booleanValue(
      body.is_active,
      true
    )
  };
}

async function addProductImages(
  client,
  productId,
  images,
  source = 'ADMIN_UPLOAD'
) {
  const unique = [];

  for (const image of images || []) {
    const url = text(
      typeof image === 'string'
        ? image
        : image.url ||
            image.image_url
    );

    if (
      !url ||
      unique.some(
        (item) => item.url === url
      )
    ) {
      continue;
    }

    unique.push({
      url,
      publicId:
        typeof image === 'object'
          ? text(
              image.public_id ||
                image.publicId
            ) || null
          : null,
      imageKey:
        typeof image === 'object'
          ? normalizeImageKey(
              image.image_key ||
                image.imageKey
            )
          : null,
      imageType:
        typeof image === 'object'
          ? text(
              image.image_type ||
                image.imageType
            ).toUpperCase()
          : '',
      source:
        typeof image === 'object'
          ? text(
              image.source
            ).toUpperCase() || source
          : source
    });
  }

  for (
    let index = 0;
    index < unique.length;
    index += 1
  ) {
    const item = unique[index];

    const imageType = [
      'PRIMARY',
      'FRONT',
      'BACK',
      'OTHER'
    ].includes(item.imageType)
      ? item.imageType
      : index === 0
        ? 'PRIMARY'
        : 'OTHER';

    const imageSource = [
      'ADMIN_UPLOAD',
      'BULK_ZIP',
      'URL',
      'CLOUDINARY',
      'LEGACY_JSON',
      'HSN_FALLBACK'
    ].includes(item.source)
      ? item.source
      : source;

    if (index === 0) {
      await client.query(
        `UPDATE product_images
         SET is_primary = false,
             updated_at = NOW()
         WHERE product_id = $1`,
        [productId]
      );
    }

    await client.query(
      `INSERT INTO product_images (
         product_id,
         image_url,
         public_id,
         image_key,
         image_type,
         sort_order,
         is_primary,
         source,
         created_at,
         updated_at
       ) VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         NOW(),
         NOW()
       )
       ON CONFLICT (
         product_id,
         image_url
       )
       DO UPDATE SET
         public_id =
           COALESCE(
             EXCLUDED.public_id,
             product_images.public_id
           ),
         image_key =
           COALESCE(
             EXCLUDED.image_key,
             product_images.image_key
           ),
         image_type =
           EXCLUDED.image_type,
         sort_order =
           EXCLUDED.sort_order,
         is_primary =
           EXCLUDED.is_primary,
         source =
           EXCLUDED.source,
         updated_at = NOW()`,
      [
        productId,
        item.url,
        item.publicId,
        item.imageKey,
        imageType,
        index,
        index === 0,
        imageSource
      ]
    );
  }

  const aggregate =
    await client.query(
      `SELECT
         COALESCE(
           jsonb_agg(
             image_url
             ORDER BY
               is_primary DESC,
               sort_order,
               created_at
           ),
           '[]'::jsonb
         ) AS images
       FROM product_images
       WHERE product_id = $1`,
      [productId]
    );

  await client.query(
    `UPDATE "Products"
     SET images = $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [
      productId,
      JSON.stringify(
        aggregate.rows[0]?.images || []
      )
    ]
  );

  return (
    aggregate.rows[0]?.images || []
  );
}

async function initializeProductInventory(
  client,
  productId
) {
  const locations = await client.query(
    `SELECT id
     FROM inventory_locations
     WHERE is_active = true`
  );

  for (const location of locations.rows) {
    await ensureInventoryRows(
      client,
      [productId],
      location.id
    );
  }
}

async function applyOpeningStock(
  client,
  productId,
  body
) {
  const openingStock = numberOrNull(
    body.opening_stock ??
      body.openingStock
  );

  if (openingStock === null) {
    return null;
  }

  if (openingStock < 0) {
    throw new Error(
      'opening_stock must be non-negative'
    );
  }

  const location =
    await getLocationByCode(
      client,
      text(
        body.location_code ||
          body.locationCode ||
          'MAIN-SHOP'
      ).toUpperCase()
    );

  if (!location) {
    throw new Error(
      'Inventory location not found'
    );
  }

  await ensureInventoryRows(
    client,
    [productId],
    location.id
  );

  const current = await client.query(
    `SELECT
       on_hand,
       reserved
     FROM product_inventory
     WHERE product_id = $1
       AND location_id = $2
     FOR UPDATE`,
    [productId, location.id]
  );

  const stockBefore = Number(
    current.rows[0]?.on_hand || 0
  );

  const reserved = Number(
    current.rows[0]?.reserved || 0
  );

  if (openingStock < reserved) {
    throw new Error(
      'opening_stock cannot be lower than reserved stock'
    );
  }

  const delta = Number(
    (
      openingStock - stockBefore
    ).toFixed(3)
  );

  await client.query(
    `UPDATE product_inventory
     SET on_hand = $3,
         updated_at = NOW()
     WHERE product_id = $1
       AND location_id = $2`,
    [
      productId,
      location.id,
      openingStock
    ]
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
         reference_number,
         created_at
       ) VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         'Product opening stock',
         $7,
         NOW()
       )`,
      [
        productId,
        location.id,
        stockBefore === 0
          ? 'OPENING_STOCK'
          : 'STOCK_CORRECTION',
        delta,
        stockBefore,
        openingStock,
        body.import_reference || null
      ]
    );
  }

  return {
    location_id: location.id,
    on_hand: openingStock,
    reserved,
    available_stock:
      openingStock - reserved
  };
}

async function createProduct(
  client,
  body,
  images = []
) {
  const validationError =
    validateProduct(body);

  if (validationError) {
    const error = new Error(
      validationError
    );

    error.status = 400;
    throw error;
  }

  const brand = await resolveBrand(
    client,
    body
  );

  const category =
    await resolveCategory(
      client,
      body
    );

  const value = productValues(
    body,
    brand,
    category
  );

  const result = await client.query(
    `INSERT INTO "Products" (
       sku,
       name,
       model_name,
       brand,
       brand_id,
       category_slug,
       category_id,
       hsn_code,
       hsn_percentage,
       mrp,
       mahaveer_price,
       purchase_price,
       discount_b2b,
       discount_b2c,
       weight,
       length,
       width,
       height,
       description,
       images,
       published,
       barcode,
       colour,
       image_key,
       unit,
       pack_size,
       reorder_level,
       track_inventory,
       is_active,
       created_at,
       updated_at
     ) VALUES (
       COALESCE(
         $1,
         'MAH-' ||
         LPAD(
           nextval(
             'products_sku_seq'
           )::text,
           6,
           '0'
         )
       ),
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10,
       $11,
       $12,
       $13,
       $14,
       $15,
       $16,
       $17,
       $18,
       $19,
       '[]'::jsonb,
       $20,
       $21,
       $22,
       $23,
       $24,
       $25,
       $26,
       $27,
       $28,
       NOW(),
       NOW()
     )
     RETURNING *`,
    [
      value.sku,
      value.name,
      value.model_name,
      value.brand,
      value.brand_id,
      value.category_slug,
      value.category_id,
      value.hsn_code,
      value.hsn_percentage,
      value.mrp,
      value.mahaveer_price,
      value.purchase_price,
      value.discount_b2b,
      value.discount_b2c,
      value.weight,
      value.length,
      value.width,
      value.height,
      value.description,
      value.published,
      value.barcode,
      value.colour,
      value.image_key,
      value.unit,
      value.pack_size,
      value.reorder_level,
      value.track_inventory,
      value.is_active
    ]
  );

  const product = result.rows[0];

  const autoSkuNumber = String(
    product.sku || ''
  ).match(/^MAH-(\d+)$/i);

  if (autoSkuNumber) {
    await client.query(
      `SELECT setval(
         'products_sku_seq',
         GREATEST(
           (
             SELECT last_value
             FROM products_sku_seq
           ),
           $1::bigint
         ),
         true
       )`,
      [Number(autoSkuNumber[1])]
    );
  }

  await initializeProductInventory(
    client,
    product.id
  );

  const finalImages =
    await addProductImages(
      client,
      product.id,
      images,
      images.some(
        (item) =>
          typeof item === 'object' &&
          item.public_id
      )
        ? 'CLOUDINARY'
        : 'URL'
    );

  const stock = await applyOpeningStock(
    client,
    product.id,
    body
  );

  return {
    ...product,
    images: finalImages,
    stock
  };
}

async function updateProduct(
  client,
  productId,
  body,
  images = null
) {
  const existingResult =
    await client.query(
      `SELECT *
       FROM "Products"
       WHERE id = $1
       FOR UPDATE`,
      [productId]
    );

  if (!existingResult.rowCount) {
    return null;
  }

  const existing =
    existingResult.rows[0];

  const merged = {
    ...existing,
    ...body
  };

  const validationError =
    validateProduct(merged);

  if (validationError) {
    const error = new Error(
      validationError
    );

    error.status = 400;
    throw error;
  }

  const brand = await resolveBrand(
    client,
    merged
  );

  const category =
    await resolveCategory(
      client,
      merged
    );

  const value = productValues(
    merged,
    brand,
    category
  );

  const result = await client.query(
    `UPDATE "Products"
     SET sku = COALESCE($2, sku),
         name = $3,
         model_name = $4,
         brand = $5,
         brand_id = $6,
         category_slug = $7,
         category_id = $8,
         hsn_code = $9,
         hsn_percentage = $10,
         mrp = $11,
         mahaveer_price = $12,
         purchase_price = $13,
         discount_b2b = $14,
         discount_b2c = $15,
         weight = $16,
         length = $17,
         width = $18,
         height = $19,
         description = $20,
         published = $21,
         barcode = $22,
         colour = $23,
         image_key = $24,
         unit = $25,
         pack_size = $26,
         reorder_level = $27,
         track_inventory = $28,
         is_active = $29,
         deleted_at =
           CASE
             WHEN $29
               THEN NULL
             ELSE deleted_at
           END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      productId,
      value.sku,
      value.name,
      value.model_name,
      value.brand,
      value.brand_id,
      value.category_slug,
      value.category_id,
      value.hsn_code,
      value.hsn_percentage,
      value.mrp,
      value.mahaveer_price,
      value.purchase_price,
      value.discount_b2b,
      value.discount_b2c,
      value.weight,
      value.length,
      value.width,
      value.height,
      value.description,
      value.published,
      value.barcode,
      value.colour,
      value.image_key,
      value.unit,
      value.pack_size,
      value.reorder_level,
      value.track_inventory,
      value.is_active
    ]
  );

  const updatedProduct =
    result.rows[0];

  const autoSkuNumber = String(
    updatedProduct.sku || ''
  ).match(/^MAH-(\d+)$/i);

  if (autoSkuNumber) {
    await client.query(
      `SELECT setval(
         'products_sku_seq',
         GREATEST(
           (
             SELECT last_value
             FROM products_sku_seq
           ),
           $1::bigint
         ),
         true
       )`,
      [Number(autoSkuNumber[1])]
    );
  }

  await initializeProductInventory(
    client,
    productId
  );

  let finalImages =
    existing.images || [];

  if (Array.isArray(images)) {
    await client.query(
      `DELETE FROM product_images
       WHERE product_id = $1`,
      [productId]
    );

    finalImages =
      await addProductImages(
        client,
        productId,
        images,
        images.some(
          (item) =>
            typeof item === 'object' &&
            item.public_id
        )
          ? 'CLOUDINARY'
          : 'URL'
      );
  }

  const stock = await applyOpeningStock(
    client,
    productId,
    body
  );

  return {
    ...updatedProduct,
    images: finalImages,
    stock
  };
}

async function createOrUpdateProduct(
  client,
  body,
  images = [],
  upsert = false
) {
  const sku = sanitizeSku(body.sku);

  if (upsert && sku) {
    const existing =
      await client.query(
        `SELECT id
         FROM "Products"
         WHERE sku = $1
         LIMIT 1`,
        [sku]
      );

    if (existing.rowCount) {
      const product =
        await updateProduct(
          client,
          existing.rows[0].id,
          body,
          images.length
            ? images
            : null
        );

      return {
        product,
        operation: 'UPDATED'
      };
    }
  }

  const product = await createProduct(
    client,
    body,
    images
  );

  return {
    product,
    operation: 'CREATED'
  };
}

async function uploadRequestFiles(
  files,
  keyPrefix
) {
  if (
    !Array.isArray(files) ||
    !files.length
  ) {
    return [];
  }

  if (!cloudinaryReady()) {
    throw new Error(
      'Cloudinary environment variables are missing'
    );
  }

  const uploaded = [];

  for (
    let index = 0;
    index < files.length;
    index += 1
  ) {
    const file = files[index];

    if (
      !String(
        file.mimetype || ''
      ).startsWith('image/')
    ) {
      throw new Error(
        `Unsupported image file: ${file.originalname}`
      );
    }

    const publicId = `${
      normalizeImageKey(keyPrefix) ||
      `product-${Date.now()}`
    }-${index + 1}`;

    const result =
      await uploadToCloudinary(
        file.buffer,
        publicId
      );

    uploaded.push({
      url: result.secure_url,
      public_id: result.public_id,
      image_key: publicId,
      image_type:
        index === 0
          ? 'PRIMARY'
          : 'OTHER',
      source: 'CLOUDINARY'
    });
  }

  return uploaded;
}

function splitImageFileName(path) {
  const fileName =
    text(path).split('/').pop() || '';

  const withoutExtension =
    fileName.replace(
      /\.[^/.]+$/,
      ''
    );

  const match =
    withoutExtension.match(
      /^(.*?)(?:[-_](front|back|primary|main|other))?$/i
    );

  const base = normalizeImageKey(
    match?.[1] || withoutExtension
  );

  const suffix = text(
    match?.[2]
  ).toUpperCase();

  const imageType =
    suffix === 'BACK'
      ? 'BACK'
      : suffix === 'FRONT'
        ? 'FRONT'
        : [
              'PRIMARY',
              'MAIN'
            ].includes(suffix)
          ? 'PRIMARY'
          : 'OTHER';

  return {
    fileName,
    base,
    imageType
  };
}

async function findImageProduct(
  client,
  rawKey
) {
  const key =
    normalizeImageKey(rawKey);

  if (!key) {
    return {
      product: null,
      matchType: null,
      ambiguous: false
    };
  }

  const sku = await client.query(
    `SELECT
       id,
       sku,
       image_key
     FROM "Products"
     WHERE LOWER(sku) = LOWER($1)
       AND deleted_at IS NULL
     LIMIT 2`,
    [key]
  );

  if (sku.rowCount === 1) {
    return {
      product: sku.rows[0],
      matchType: 'sku',
      ambiguous: false
    };
  }

  const imageKey =
    await client.query(
      `SELECT
         id,
         sku,
         image_key
       FROM "Products"
       WHERE LOWER(image_key) =
             LOWER($1)
         AND deleted_at IS NULL
       LIMIT 2`,
      [key]
    );

  if (imageKey.rowCount === 1) {
    return {
      product: imageKey.rows[0],
      matchType: 'image_key',
      ambiguous: false
    };
  }

  if (imageKey.rowCount > 1) {
    return {
      product: null,
      matchType: 'image_key',
      ambiguous: true
    };
  }

  const barcodeColour =
    await client.query(
      `SELECT
         id,
         sku,
         image_key
       FROM "Products"
       WHERE REGEXP_REPLACE(
         REGEXP_REPLACE(
           LOWER(
             COALESCE(barcode, '') ||
             '-' ||
             COALESCE(colour, '')
           ),
           '\\s+',
           '-',
           'g'
         ),
         '[^a-z0-9-]',
         '',
         'g'
       ) = $1
         AND deleted_at IS NULL
       LIMIT 2`,
      [key]
    );

  if (
    barcodeColour.rowCount === 1
  ) {
    return {
      product:
        barcodeColour.rows[0],
      matchType:
        'barcode_colour',
      ambiguous: false
    };
  }

  if (
    barcodeColour.rowCount > 1
  ) {
    return {
      product: null,
      matchType:
        'barcode_colour',
      ambiguous: true
    };
  }

  const leadingCode =
    key.match(
      /^([0-9a-z]+)/i
    )?.[1] || null;

  if (leadingCode) {
    const barcode =
      await client.query(
        `SELECT
           id,
           sku,
           image_key
         FROM "Products"
         WHERE LOWER(barcode) =
               LOWER($1)
           AND deleted_at IS NULL
         LIMIT 2`,
        [leadingCode]
      );

    if (barcode.rowCount === 1) {
      return {
        product: barcode.rows[0],
        matchType:
          'barcode_unique',
        ambiguous: false
      };
    }

    if (barcode.rowCount > 1) {
      return {
        product: null,
        matchType: 'barcode',
        ambiguous: true
      };
    }

    const hsn = await client.query(
      `SELECT
         id,
         sku,
         image_key
       FROM "Products"
       WHERE LOWER(hsn_code) =
             LOWER($1)
         AND deleted_at IS NULL
       LIMIT 2`,
      [leadingCode]
    );

    if (hsn.rowCount === 1) {
      return {
        product: hsn.rows[0],
        matchType: 'hsn_unique',
        ambiguous: false
      };
    }

    if (hsn.rowCount > 1) {
      return {
        product: null,
        matchType: 'hsn',
        ambiguous: true
      };
    }
  }

  return {
    product: null,
    matchType: null,
    ambiguous: false
  };
}

async function attachImage(
  client,
  product,
  image
) {
  const primaryResult =
    await client.query(
      `SELECT
         COUNT(*)::int AS total
       FROM product_images
       WHERE product_id = $1
         AND is_primary = true`,
      [product.id]
    );

  const makePrimary =
    image.image_type === 'PRIMARY' ||
    (
      image.image_type === 'FRONT' &&
      Number(
        primaryResult.rows[0]
          ?.total || 0
      ) === 0
    );

  if (makePrimary) {
    await client.query(
      `UPDATE product_images
       SET is_primary = false,
           updated_at = NOW()
       WHERE product_id = $1`,
      [product.id]
    );
  }

  const sortResult =
    await client.query(
      `SELECT
         COALESCE(
           MAX(sort_order),
           -1
         ) + 1 AS next_order
       FROM product_images
       WHERE product_id = $1`,
      [product.id]
    );

  const sortOrder = Number(
    sortResult.rows[0]
      ?.next_order || 0
  );

  await client.query(
    `INSERT INTO product_images (
       product_id,
       image_url,
       public_id,
       image_key,
       image_type,
       sort_order,
       is_primary,
       source,
       created_at,
       updated_at
     ) VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       'BULK_ZIP',
       NOW(),
       NOW()
     )
     ON CONFLICT (
       product_id,
       image_url
     )
     DO UPDATE SET
       public_id =
         EXCLUDED.public_id,
       image_key =
         EXCLUDED.image_key,
       image_type =
         EXCLUDED.image_type,
       is_primary =
         EXCLUDED.is_primary,
       updated_at = NOW()`,
    [
      product.id,
      image.url,
      image.public_id,
      image.image_key,
      image.image_type,
      sortOrder,
      makePrimary
    ]
  );

  const aggregate =
    await client.query(
      `SELECT
         COALESCE(
           jsonb_agg(
             image_url
             ORDER BY
               is_primary DESC,
               sort_order,
               created_at
           ),
           '[]'::jsonb
         ) AS images
       FROM product_images
       WHERE product_id = $1`,
      [product.id]
    );

  await client.query(
    `UPDATE "Products"
     SET images = $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [
      product.id,
      JSON.stringify(
        aggregate.rows[0].images
      )
    ]
  );
}

function defaultHeader(
  headers,
  field
) {
  const normalized = headers.map(
    (raw) => ({
      raw,
      key: text(raw).toLowerCase()
    })
  );

  const find = (...values) => {
    for (const value of values) {
      const exact =
        normalized.find(
          (entry) =>
            entry.key ===
            value.toLowerCase()
        );

      if (exact) {
        return exact.raw;
      }
    }

    for (const value of values) {
      const partial =
        normalized.find((entry) =>
          entry.key.includes(
            value.toLowerCase()
          )
        );

      if (partial) {
        return partial.raw;
      }
    }

    return '';
  };

  const map = {
    sku: [
      'SKU',
      'ITEM CODE',
      'PRODUCT CODE'
    ],
    name: [
      'ITEM NAME',
      'PRODUCT NAME',
      'NAME'
    ],
    model_name: [
      'MODEL NAME',
      'MODEL',
      'ITEM CODE'
    ],
    brand: ['BRAND'],
    category_slug: [
      'CATEGORY',
      'CATEGORY SLUG',
      'GROUP NAME'
    ],
    hsn_code: [
      'HSN CODE',
      'HSN'
    ],
    hsn_percentage: [
      'GST %',
      'GST PERCENTAGE',
      'HSN PERCENTAGE',
      'PERCENTAGE'
    ],
    mrp: ['MRP'],
    mahaveer_price: [
      'SALES RATE',
      'SELLING RATE',
      'S. RATE',
      'W.S RATE',
      'W.S  RATE',
      'MAHAVEER PRICE'
    ],
    purchase_price: [
      'PURCHASE RATE',
      'PURCHASE PRICE',
      'P RATE',
      'P  RATE'
    ],
    discount_b2b: [
      'DISCOUNT B2B',
      'B2B DISCOUNT'
    ],
    discount_b2c: [
      'DISCOUNT B2C',
      'B2C DISCOUNT'
    ],
    weight: [
      'WEIGHT',
      'REAM WEIGHT IN KG'
    ],
    length: ['LENGTH'],
    width: ['WIDTH'],
    height: ['HEIGHT'],
    description: [
      'DESCRIPTION'
    ],
    imageUrls: [
      'PHOTO',
      'IMAGE URL',
      'IMAGE'
    ],
    barcode: [
      'BARCODE',
      'EAN',
      'UPC'
    ],
    colour: [
      'COLOUR',
      'COLOR'
    ],
    image_code: [
      'IMAGE CODE',
      'IMAGE KEY',
      'PHOTO CODE'
    ],
    unit: ['UNIT'],
    pack_size: [
      'PACK SIZE',
      'PACK QTY',
      'PACK QUANTITY'
    ],
    reorder_level: [
      'REORDER LEVEL',
      'MIN STOCK',
      'MINIMUM STOCK'
    ],
    opening_stock: [
      'OPENING STOCK',
      'STOCK',
      'QTY',
      'QUANTITY'
    ]
  };

  return find(
    ...(map[field] || [])
  );
}

function defaultMapping(headers) {
  const fields = [
    'sku',
    'name',
    'model_name',
    'brand',
    'category_slug',
    'hsn_code',
    'hsn_percentage',
    'mrp',
    'mahaveer_price',
    'purchase_price',
    'discount_b2b',
    'discount_b2c',
    'weight',
    'length',
    'width',
    'height',
    'description',
    'imageUrls',
    'barcode',
    'colour',
    'image_code',
    'unit',
    'pack_size',
    'reorder_level',
    'opening_stock'
  ];

  return Object.fromEntries(
    fields.map((field) => [
      field,
      defaultHeader(
        headers,
        field
      )
    ])
  );
}

function valueFromRow(
  row,
  mapping,
  field
) {
  const header = mapping[field];

  return header
    ? row[header]
    : undefined;
}

function payloadFromRow(
  row,
  sheetName,
  mapping,
  options
) {
  const categorySource = text(
    options.categorySource ||
      'sheet'
  ).toLowerCase();

  let categorySlug = '';

  if (categorySource === 'fixed') {
    categorySlug = text(
      options.fixedCategorySlug
    );
  } else if (
    categorySource === 'header'
  ) {
    categorySlug = text(
      row[options.categoryHeader]
    );
  } else if (
    categorySource === 'group'
  ) {
    categorySlug = text(
      row['GROUP NAME']
    );
  } else {
    categorySlug = sheetName;
  }

  return {
    sku: valueFromRow(
      row,
      mapping,
      'sku'
    ),
    name: valueFromRow(
      row,
      mapping,
      'name'
    ),
    model_name: valueFromRow(
      row,
      mapping,
      'model_name'
    ),
    brand: valueFromRow(
      row,
      mapping,
      'brand'
    ),
    category_slug: normalizeSlug(
      categorySlug ||
        valueFromRow(
          row,
          mapping,
          'category_slug'
        )
    ),
    hsn_code: valueFromRow(
      row,
      mapping,
      'hsn_code'
    ),
    hsn_percentage: valueFromRow(
      row,
      mapping,
      'hsn_percentage'
    ),
    mrp: valueFromRow(
      row,
      mapping,
      'mrp'
    ),
    mahaveer_price:
      valueFromRow(
        row,
        mapping,
        'mahaveer_price'
      ) ??
      valueFromRow(
        row,
        mapping,
        'mrp'
      ),
    purchase_price: valueFromRow(
      row,
      mapping,
      'purchase_price'
    ),
    discount_b2b: valueFromRow(
      row,
      mapping,
      'discount_b2b'
    ),
    discount_b2c: valueFromRow(
      row,
      mapping,
      'discount_b2c'
    ),
    weight: valueFromRow(
      row,
      mapping,
      'weight'
    ),
    length: valueFromRow(
      row,
      mapping,
      'length'
    ),
    width: valueFromRow(
      row,
      mapping,
      'width'
    ),
    height: valueFromRow(
      row,
      mapping,
      'height'
    ),
    description:
      valueFromRow(
        row,
        mapping,
        'description'
      ) ||
      valueFromRow(
        row,
        mapping,
        'name'
      ),
    imageUrls: valueFromRow(
      row,
      mapping,
      'imageUrls'
    ),
    barcode: valueFromRow(
      row,
      mapping,
      'barcode'
    ),
    colour: valueFromRow(
      row,
      mapping,
      'colour'
    ),
    image_code: valueFromRow(
      row,
      mapping,
      'image_code'
    ),
    unit: valueFromRow(
      row,
      mapping,
      'unit'
    ),
    pack_size: valueFromRow(
      row,
      mapping,
      'pack_size'
    ),
    reorder_level: valueFromRow(
      row,
      mapping,
      'reorder_level'
    ),
    opening_stock: valueFromRow(
      row,
      mapping,
      'opening_stock'
    ),
    location_code:
      options.locationCode ||
      'MAIN-SHOP',
    published: booleanValue(
      options.published,
      true
    ),
    track_inventory: booleanValue(
      options.trackInventory,
      true
    ),
    is_active: true
  };
}

async function resolveImagesForPayload(
  body
) {
  const direct =
    imageUrlsFromBody(body).map(
      (url, index) => ({
        url,
        image_type:
          index === 0
            ? 'PRIMARY'
            : 'OTHER',
        source: 'URL'
      })
    );

  if (direct.length) {
    return direct;
  }

  const key = imageIdentity(body);

  const keyUrl =
    await resolveCloudinaryImage(key);

  if (keyUrl) {
    return [
      {
        url: keyUrl,
        image_key: key,
        image_type: 'PRIMARY',
        source: 'CLOUDINARY'
      }
    ];
  }

  const hsn = sanitizeHsn(
    body.hsn_code
  );

  const hsnUrl =
    await resolveCloudinaryImage(hsn);

  return hsnUrl
    ? [
        {
          url: hsnUrl,
          image_key: hsn,
          image_type: 'PRIMARY',
          source: 'HSN_FALLBACK'
        }
      ]
    : [];
}

router.get(
  '/ping-bulk',
  (_req, res) =>
    res.json({
      ok: true,
      route:
        'products routes working'
    })
);

router.get(
  '/brands',
  async (req, res) => {
    try {
      const query = text(
        req.query.query ||
          req.query.q
      );

      const activeOnly =
        req.query.activeOnly ===
        undefined
          ? true
          : booleanValue(
              req.query.activeOnly,
              true
            );

      const params = [];
      const where = [];

      if (activeOnly) {
        where.push(
          'b.is_active = true'
        );
      }

      if (query) {
        params.push(`%${query}%`);

        where.push(
          `(b.name ILIKE $${params.length}
            OR b.slug ILIKE $${params.length})`
        );
      }

      const result =
        await pool.query(
          `SELECT
             b.id,
             b.name,
             b.slug,
             b.is_active,
             COALESCE(
               jsonb_agg(
                 a.alias
                 ORDER BY a.alias
               )
               FILTER (
                 WHERE a.id IS NOT NULL
               ),
               '[]'::jsonb
             ) AS aliases
           FROM brands b
           LEFT JOIN brand_aliases a
             ON a.brand_id = b.id
           ${
             where.length
               ? `WHERE ${where.join(
                   ' AND '
                 )}`
               : ''
           }
           GROUP BY b.id
           ORDER BY b.name`,
          params
        );

      return res.json({
        brands: result.rows
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

router.post(
  '/link-image-by-key',
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const imageKey =
        normalizeImageKey(
          req.body?.image_key ||
            req.body?.sku ||
            req.body?.barcode ||
            req.body?.hsn_code
        );

      const imageUrl = text(
        req.body?.image_url
      );

      if (!imageKey || !imageUrl) {
        return res.status(400).json({
          error:
            'image_key and image_url are required'
        });
      }

      await client.query('BEGIN');

      const match =
        await findImageProduct(
          client,
          imageKey
        );

      if (!match.product) {
        await client.query(
          'ROLLBACK'
        );

        return res
          .status(
            match.ambiguous
              ? 409
              : 404
          )
          .json({
            error: match.ambiguous
              ? 'Image key matches multiple products'
              : 'No matching product found',
            image_key: imageKey
          });
      }

      await attachImage(
        client,
        match.product,
        {
          url: imageUrl,
          public_id:
            text(
              req.body?.public_id
            ) || null,
          image_key: imageKey,
          image_type: text(
            req.body?.image_type ||
              'PRIMARY'
          ).toUpperCase()
        }
      );

      await client.query('COMMIT');

      return res.json({
        message:
          'Image linked successfully',
        product_id:
          match.product.id,
        sku: match.product.sku,
        match_type:
          match.matchType,
        image_url: imageUrl
      });
    } catch (error) {
      await client.query(
        'ROLLBACK'
      );

      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    } finally {
      client.release();
    }
  }
);

router.post(
  '/link-image-by-hsn',
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const hsnCode = sanitizeHsn(
        req.body?.hsn_code
      );

      const imageUrl = text(
        req.body?.image_url
      );

      if (!hsnCode || !imageUrl) {
        return res.status(400).json({
          error:
            'hsn_code and image_url are required'
        });
      }

      await client.query('BEGIN');

      const products =
        await client.query(
          `SELECT
             id,
             sku,
             image_key
           FROM "Products"
           WHERE hsn_code = $1
             AND deleted_at IS NULL
           LIMIT 2`,
          [hsnCode]
        );

      if (
        products.rowCount !== 1
      ) {
        await client.query(
          'ROLLBACK'
        );

        return res
          .status(
            products.rowCount > 1
              ? 409
              : 404
          )
          .json({
            error:
              products.rowCount > 1
                ? 'HSN matches multiple products'
                : 'No matching product found',
            hsn_code: hsnCode
          });
      }

      const product =
        products.rows[0];

      await attachImage(
        client,
        product,
        {
          url: imageUrl,
          public_id:
            text(
              req.body?.public_id
            ) || null,
          image_key:
            normalizeImageKey(
              hsnCode
            ),
          image_type: text(
            req.body?.image_type ||
              'PRIMARY'
          ).toUpperCase()
        }
      );

      await client.query('COMMIT');

      return res.json({
        message:
          'Image linked successfully',
        product_id: product.id,
        sku: product.sku,
        match_type: 'hsn_unique',
        image_url: imageUrl
      });
    } catch (error) {
      await client.query(
        'ROLLBACK'
      );

      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    } finally {
      client.release();
    }
  }
);

router.post(
  '/upload-zip-images',
  upload.single('zipFile'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error:
          'ZIP file is required'
      });
    }

    if (!cloudinaryReady()) {
      return res.status(500).json({
        error:
          'Cloudinary environment variables are missing'
      });
    }

    const client =
      await pool.connect();

    try {
      const directory =
        await unzipper.Open.buffer(
          req.file.buffer
        );

      const uploaded = [];
      const skipped = [];

      for (const entry of directory.files) {
        if (entry.type !== 'File') {
          continue;
        }

        const parsed =
          splitImageFileName(
            entry.path
          );

        const extension =
          parsed.fileName
            .split('.')
            .pop()
            ?.toLowerCase();

        if (
          ![
            'jpg',
            'jpeg',
            'png',
            'webp',
            'avif'
          ].includes(extension)
        ) {
          skipped.push({
            file: entry.path,
            reason:
              'Unsupported file type'
          });

          continue;
        }

        if (!parsed.base) {
          skipped.push({
            file: entry.path,
            reason:
              'Invalid image filename'
          });

          continue;
        }

        try {
          const buffer =
            await entry.buffer();

          const publicId =
            parsed.imageType ===
            'OTHER'
              ? parsed.base
              : `${parsed.base}-${parsed.imageType.toLowerCase()}`;

          const cloudinaryResult =
            await uploadToCloudinary(
              buffer,
              publicId
            );

          await client.query(
            'BEGIN'
          );

          const match =
            await findImageProduct(
              client,
              parsed.base
            );

          if (!match.product) {
            await client.query(
              'ROLLBACK'
            );

            skipped.push({
              file: entry.path,
              image_key:
                parsed.base,
              url:
                cloudinaryResult.secure_url,
              reason:
                match.ambiguous
                  ? 'Ambiguous product match'
                  : 'No matching product'
            });

            continue;
          }

          await attachImage(
            client,
            match.product,
            {
              url:
                cloudinaryResult.secure_url,
              public_id:
                cloudinaryResult.public_id,
              image_key:
                parsed.base,
              image_type:
                parsed.imageType
            }
          );

          await client.query(
            'COMMIT'
          );

          uploaded.push({
            file: entry.path,
            product_id:
              match.product.id,
            sku:
              match.product.sku,
            image_key:
              parsed.base,
            image_type:
              parsed.imageType,
            match_type:
              match.matchType,
            url:
              cloudinaryResult.secure_url,
            public_id:
              cloudinaryResult.public_id
          });
        } catch (error) {
          try {
            await client.query(
              'ROLLBACK'
            );
          } catch {}

          skipped.push({
            file: entry.path,
            image_key:
              parsed.base,
            reason: String(
              error.message || error
            )
          });
        }
      }

      return res.status(201).json({
        message:
          'ZIP image processing completed',
        uploadedCount:
          uploaded.length,
        skippedCount:
          skipped.length,
        uploaded,
        skipped
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    } finally {
      client.release();
    }
  }
);

router.post(
  '/',
  upload.array('images', 20),
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const body =
        req.body || {};

      const uploadedFiles =
        await uploadRequestFiles(
          req.files || [],
          body.sku ||
            imageIdentity(body) ||
            body.name
        );

      const resolvedImages =
        uploadedFiles.length
          ? uploadedFiles
          : await resolveImagesForPayload(
              body
            );

      await client.query('BEGIN');

      const product =
        await createProduct(
          client,
          body,
          resolvedImages
        );

      await client.query('COMMIT');

      return res.status(201).json({
        message: 'Product saved',
        product
      });
    } catch (error) {
      await client.query(
        'ROLLBACK'
      );

      const status =
        error.status ||
        (
          String(error.code) ===
          '23505'
            ? 409
            : 500
        );

      return res.status(status).json({
        error: String(
          error.message || error
        )
      });
    } finally {
      client.release();
    }
  }
);

router.post(
  '/bulk-upload',
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error:
          'Excel file is required'
      });
    }

    const client =
      await pool.connect();

    let jobId = null;

    try {
      const requestedMapping =
        typeof req.body.mapping ===
        'string'
          ? safeJson(
              req.body.mapping,
              {}
            )
          : req.body.mapping || {};

      const selectedSheets =
        typeof req.body
          .selectedSheets === 'string'
          ? safeJson(
              req.body.selectedSheets,
              []
            )
          : req.body.selectedSheets ||
            [];

      const options = {
        categorySource:
          req.body.categorySource ||
          'sheet',
        fixedCategorySlug:
          req.body
            .fixedCategorySlug || '',
        categoryHeader:
          req.body.categoryHeader ||
          '',
        locationCode:
          req.body.locationCode ||
          'MAIN-SHOP',
        published:
          req.body.published,
        trackInventory:
          req.body.trackInventory,
        upsert: booleanValue(
          req.body.upsert,
          true
        )
      };

      const workbook = XLSX.read(
        req.file.buffer,
        {
          type: 'buffer'
        }
      );

      const rows = [];

      for (
        const sheetName of
        workbook.SheetNames
      ) {
        if (
          Array.isArray(
            selectedSheets
          ) &&
          selectedSheets.length &&
          !selectedSheets.includes(
            sheetName
          )
        ) {
          continue;
        }

        const sheetRows =
          XLSX.utils
            .sheet_to_json(
              workbook.Sheets[
                sheetName
              ],
              {
                defval: ''
              }
            )
            .filter((row) =>
              Object.values(row).some(
                (value) =>
                  text(value)
              )
            );

        if (!sheetRows.length) {
          continue;
        }

        const headers = [
          ...new Set(
            sheetRows.flatMap(
              (row) =>
                Object.keys(row)
            )
          )
        ];

        const mapping = {
          ...defaultMapping(
            headers
          ),
          ...requestedMapping
        };

        sheetRows.forEach(
          (row, index) =>
            rows.push({
              sheetName,
              rowNumber: index + 2,
              raw: row,
              payload:
                payloadFromRow(
                  row,
                  sheetName,
                  mapping,
                  options
                )
            })
        );
      }

      if (!rows.length) {
        return res.status(400).json({
          error:
            'No product rows found'
        });
      }

      const jobResult =
        await pool.query(
          `INSERT INTO product_import_jobs (
             file_name,
             import_type,
             status,
             total_rows,
             options,
             started_at,
             created_at,
             updated_at
           ) VALUES (
             $1,
             'EXCEL',
             'PROCESSING',
             $2,
             $3::jsonb,
             NOW(),
             NOW(),
             NOW()
           )
           RETURNING id`,
          [
            req.file.originalname,
            rows.length,
            JSON.stringify(options)
          ]
        );

      jobId =
        jobResult.rows[0].id;

      const errors = [];
      const products = [];

      await client.query('BEGIN');

      for (
        let index = 0;
        index < rows.length;
        index += 1
      ) {
        const item = rows[index];

        const savepoint =
          `row_${index + 1}`;

        await client.query(
          `SAVEPOINT ${savepoint}`
        );

        try {
          const images =
            await resolveImagesForPayload(
              item.payload
            );

          const result =
            await createOrUpdateProduct(
              client,
              {
                ...item.payload,
                import_reference:
                  jobId
              },
              images,
              options.upsert
            );

          const product =
            result.product;

          products.push({
            product_id:
              product.id,
            sku: product.sku,
            operation:
              result.operation,
            sheet:
              item.sheetName,
            row:
              item.rowNumber
          });

          await client.query(
            `INSERT INTO product_import_rows (
               job_id,
               sheet_name,
               row_number,
               sku,
               barcode,
               operation_status,
               product_id,
               raw_data,
               created_at
             ) VALUES (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6,
               $7,
               $8::jsonb,
               NOW()
             )`,
            [
              jobId,
              item.sheetName,
              item.rowNumber,
              product.sku,
              product.barcode,
              result.operation,
              product.id,
              JSON.stringify(
                item.raw
              )
            ]
          );

          await client.query(
            `RELEASE SAVEPOINT ${savepoint}`
          );
        } catch (error) {
          await client.query(
            `ROLLBACK TO SAVEPOINT ${savepoint}`
          );

          errors.push({
            sheet:
              item.sheetName,
            row:
              item.rowNumber,
            name: text(
              item.payload.name
            ),
            error: String(
              error.message || error
            )
          });

          await client.query(
            `INSERT INTO product_import_rows (
               job_id,
               sheet_name,
               row_number,
               sku,
               barcode,
               operation_status,
               error_message,
               raw_data,
               created_at
             ) VALUES (
               $1,
               $2,
               $3,
               $4,
               $5,
               'FAILED',
               $6,
               $7::jsonb,
               NOW()
             )`,
            [
              jobId,
              item.sheetName,
              item.rowNumber,
              sanitizeSku(
                item.payload.sku
              ),
              sanitizeBarcode(
                item.payload
                  .barcode
              ),
              String(
                error.message ||
                  error
              ),
              JSON.stringify(
                item.raw
              )
            ]
          );

          await client.query(
            `RELEASE SAVEPOINT ${savepoint}`
          );
        }
      }

      await client.query('COMMIT');

      const status =
        errors.length === 0
          ? 'COMPLETED'
          : products.length
            ? 'PARTIAL'
            : 'FAILED';

      await pool.query(
        `UPDATE product_import_jobs
         SET status = $2,
             success_rows = $3,
             failed_rows = $4,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [
          jobId,
          status,
          products.length,
          errors.length
        ]
      );

      return res
        .status(
          errors.length
            ? 207
            : 201
        )
        .json({
          message:
            'Bulk upload completed',
          jobId,
          total: rows.length,
          success:
            products.length,
          failed:
            errors.length,
          products,
          errors
        });
    } catch (error) {
      try {
        await client.query(
          'ROLLBACK'
        );
      } catch {}

      if (jobId) {
        await pool
          .query(
            `UPDATE product_import_jobs
             SET status = 'FAILED',
                 error_message = $2,
                 completed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [
              jobId,
              String(
                error.message ||
                  error
              )
            ]
          )
          .catch(() => {});
      }

      return res.status(500).json({
        error: String(
          error.message || error
        ),
        jobId
      });
    } finally {
      client.release();
    }
  }
);

router.post(
  '/bulk-json',
  async (req, res) => {
    const productsInput =
      Array.isArray(
        req.body?.products
      )
        ? req.body.products
        : [];

    if (!productsInput.length) {
      return res.status(400).json({
        error:
          'products array is required'
      });
    }

    const client =
      await pool.connect();

    const products = [];
    const errors = [];

    try {
      await client.query('BEGIN');

      for (
        let index = 0;
        index < productsInput.length;
        index += 1
      ) {
        const savepoint =
          `json_row_${index + 1}`;

        await client.query(
          `SAVEPOINT ${savepoint}`
        );

        try {
          const body =
            productsInput[index] ||
            {};

          const images =
            await resolveImagesForPayload(
              body
            );

          const result =
            await createOrUpdateProduct(
              client,
              body,
              images,
              req.body?.upsert !==
                false
            );

          products.push({
            ...result.product,
            operation:
              result.operation
          });

          await client.query(
            `RELEASE SAVEPOINT ${savepoint}`
          );
        } catch (error) {
          await client.query(
            `ROLLBACK TO SAVEPOINT ${savepoint}`
          );

          errors.push({
            row: index + 1,
            name: text(
              productsInput[index]
                ?.name
            ),
            error: String(
              error.message || error
            )
          });

          await client.query(
            `RELEASE SAVEPOINT ${savepoint}`
          );
        }
      }

      await client.query('COMMIT');

      return res
        .status(
          errors.length
            ? 207
            : 201
        )
        .json({
          total:
            productsInput.length,
          success:
            products.length,
          failed:
            errors.length,
          products,
          errors
        });
    } catch (error) {
      await client.query(
        'ROLLBACK'
      );

      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    } finally {
      client.release();
    }
  }
);

router.get(
  '/imports',
  disableImportCache,
  async (req, res) => {
    try {
      const limit = Math.min(
        Math.max(
          Number.parseInt(
            req.query.limit,
            10
          ) || 25,
          1
        ),
        200
      );

      const result =
        await pool.query(
          `SELECT
             id,
             file_name,
             import_type,
             status,
             total_rows,
             success_rows,
             failed_rows,
             error_message,
             options,
             started_at,
             completed_at,
             created_at,
             updated_at
           FROM product_import_jobs
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );

      return res.status(200).json({
        jobs: result.rows
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

router.get(
  '/imports/:jobId',
  disableImportCache,
  async (req, res) => {
    try {
      const job =
        await pool.query(
          `SELECT
             id,
             file_name,
             import_type,
             status,
             total_rows,
             success_rows,
             failed_rows,
             error_message,
             options,
             started_at,
             completed_at,
             created_at,
             updated_at
           FROM product_import_jobs
           WHERE id = $1
           LIMIT 1`,
          [req.params.jobId]
        );

      if (!job.rowCount) {
        return res.status(404).json({
          error:
            'Import job not found'
        });
      }

      const rows =
        await pool.query(
          `SELECT
             id,
             job_id,
             sheet_name,
             row_number,
             sku,
             barcode,
             operation_status,
             product_id,
             error_message,
             raw_data,
             created_at
           FROM product_import_rows
           WHERE job_id = $1
           ORDER BY
             sheet_name,
             row_number`,
          [req.params.jobId]
        );

      return res.status(200).json({
        job: job.rows[0],
        rows: rows.rows
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

router.get(
  '/resolve-image/:imageKey',
  async (req, res) => {
    try {
      const imageKey =
        normalizeImageKey(
          req.params.imageKey
        );

      const image =
        await resolveCloudinaryImage(
          imageKey
        );

      return res.json({
        image_key: imageKey,
        image
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

router.get(
  '/',
  async (req, res) => {
    try {
      const page = Math.max(
        Number.parseInt(
          req.query.page,
          10
        ) || 1,
        1
      );

      const limit = Math.min(
        Math.max(
          Number.parseInt(
            req.query.limit,
            10
          ) || 20,
          1
        ),
        500
      );

      const offset =
        (page - 1) * limit;

      const customerType =
        text(
          req.query.customerType ||
            req.query.customer_type ||
            'B2C'
        ).toUpperCase() === 'B2B'
          ? 'B2B'
          : 'B2C';

      const includeInactive =
        booleanValue(
          req.query.includeInactive,
          false
        );

      const params = [];
      const where = [];

      if (!includeInactive) {
        where.push(
          `p.published = true
           AND p.is_active = true
           AND p.deleted_at IS NULL`
        );
      }

      if (
        req.query.category &&
        text(
          req.query.category
        ).toLowerCase() !== 'all'
      ) {
        params.push(
          text(
            req.query.category
          ).replace(/^\/+/, '')
        );

        where.push(
          `p.category_slug =
           $${params.length}`
        );
      }

      if (req.query.brand) {
        params.push(
          text(req.query.brand)
        );

        where.push(
          `(p.brand = $${params.length}
            OR b.name = $${params.length})`
        );
      }

      if (req.query.query) {
        params.push(
          `%${text(
            req.query.query
          )}%`
        );

        where.push(
          `(p.name ILIKE $${params.length}
            OR COALESCE(
              p.description,
              ''
            ) ILIKE $${params.length}
            OR p.sku ILIKE $${params.length}
            OR COALESCE(
              p.barcode,
              ''
            ) ILIKE $${params.length})`
        );
      }

      if (req.query.stockStatus) {
        params.push(
          text(
            req.query.stockStatus
          ).toUpperCase()
        );

        where.push(
          `COALESCE(
             inv.stock_status,
             'OUT_OF_STOCK'
           ) = $${params.length}`
        );
      }

      const whereSql =
        where.length
          ? `WHERE ${where.join(
              ' AND '
            )}`
          : '';

      const locationCode = text(
        req.query.locationCode ||
          'MAIN-SHOP'
      ).toUpperCase();

      params.push(locationCode);

      const locationIndex =
        params.length;

      params.push(limit);

      const limitIndex =
        params.length;

      params.push(offset);

      const offsetIndex =
        params.length;

      const result =
        await pool.query(
          `SELECT
             p.*,
             COALESCE(
               b.name,
               p.brand
             ) AS brand_name,
             n.label AS category_name,
             COALESCE(
               inv.on_hand,
               0
             ) AS on_hand,
             COALESCE(
               inv.reserved,
               0
             ) AS reserved,
             COALESCE(
               inv.available_stock,
               0
             ) AS available_stock,
             COALESCE(
               inv.stock_status,
               CASE
                 WHEN p.track_inventory
                   THEN 'OUT_OF_STOCK'
                 ELSE 'NOT_TRACKED'
               END
             ) AS stock_status,
             ROUND(
               COALESCE(
                 p.mahaveer_price,
                 0
               ) *
               (
                 1 -
                 COALESCE(
                   p.discount_b2b,
                   0
                 ) /
                 100.0
               ),
               2
             ) AS b2b_price,
             ROUND(
               COALESCE(
                 p.mahaveer_price,
                 0
               ) *
               (
                 1 -
                 COALESCE(
                   p.discount_b2c,
                   0
                 ) /
                 100.0
               ),
               2
             ) AS b2c_price,
             CASE
               WHEN
                 $${locationIndex}::text
                   IS NOT NULL
                 AND
                 $${locationIndex}::text
                   <> ''
                 AND
                 '${customerType}' =
                   'B2B'
                 THEN ROUND(
                   COALESCE(
                     p.mahaveer_price,
                     0
                   ) *
                   (
                     1 -
                     COALESCE(
                       p.discount_b2b,
                       0
                     ) /
                     100.0
                   ),
                   2
                 )
               ELSE ROUND(
                 COALESCE(
                   p.mahaveer_price,
                   0
                 ) *
                 (
                   1 -
                   COALESCE(
                     p.discount_b2c,
                     0
                   ) /
                   100.0
                 ),
                 2
               )
             END AS selling_price
           FROM "Products" p
           LEFT JOIN brands b
             ON b.id = p.brand_id
           LEFT JOIN "NavLinks" n
             ON n.id =
                p.category_id
           LEFT JOIN inventory_summary inv
             ON inv.product_id = p.id
            AND inv.location_code =
                $${locationIndex}
           ${whereSql}
           ORDER BY p.created_at DESC
           LIMIT $${limitIndex}
           OFFSET $${offsetIndex}`,
          params
        );

      const countParams =
        params.slice(
          0,
          locationIndex - 1
        );

      const countResult =
        await pool.query(
          `SELECT
             COUNT(*)::int AS total
           FROM "Products" p
           LEFT JOIN brands b
             ON b.id = p.brand_id
           LEFT JOIN inventory_summary inv
             ON inv.product_id = p.id
            AND inv.location_code =
                $${locationIndex}
           ${whereSql}`,
          [
            ...countParams,
            locationCode
          ]
        );

      return res.json({
        page,
        limit,
        total:
          countResult.rows[0]
            .total,
        customer_type:
          customerType,
        items: result.rows
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

router.get(
  '/:id',
  async (req, res) => {
    try {
      const customerType =
        text(
          req.query.customerType ||
            'B2C'
        ).toUpperCase() === 'B2B'
          ? 'B2B'
          : 'B2C';

      const locationCode = text(
        req.query.locationCode ||
          'MAIN-SHOP'
      ).toUpperCase();

      const result =
        await pool.query(
          `SELECT
             p.*,
             COALESCE(
               b.name,
               p.brand
             ) AS brand_name,
             n.label AS category_name,
             COALESCE(
               inv.on_hand,
               0
             ) AS on_hand,
             COALESCE(
               inv.reserved,
               0
             ) AS reserved,
             COALESCE(
               inv.available_stock,
               0
             ) AS available_stock,
             COALESCE(
               inv.stock_status,
               CASE
                 WHEN p.track_inventory
                   THEN 'OUT_OF_STOCK'
                 ELSE 'NOT_TRACKED'
               END
             ) AS stock_status,
             ROUND(
               COALESCE(
                 p.mahaveer_price,
                 0
               ) *
               (
                 1 -
                 COALESCE(
                   p.discount_b2b,
                   0
                 ) /
                 100.0
               ),
               2
             ) AS b2b_price,
             ROUND(
               COALESCE(
                 p.mahaveer_price,
                 0
               ) *
               (
                 1 -
                 COALESCE(
                   p.discount_b2c,
                   0
                 ) /
                 100.0
               ),
               2
             ) AS b2c_price,
             CASE
               WHEN $3 = 'B2B'
                 THEN ROUND(
                   COALESCE(
                     p.mahaveer_price,
                     0
                   ) *
                   (
                     1 -
                     COALESCE(
                       p.discount_b2b,
                       0
                     ) /
                     100.0
                   ),
                   2
                 )
               ELSE ROUND(
                 COALESCE(
                   p.mahaveer_price,
                   0
                 ) *
                 (
                   1 -
                   COALESCE(
                     p.discount_b2c,
                     0
                   ) /
                   100.0
                 ),
                 2
               )
             END AS selling_price,
             COALESCE(
               (
                 SELECT
                   jsonb_agg(
                     jsonb_build_object(
                       'id',
                       pi.id,
                       'image_url',
                       pi.image_url,
                       'public_id',
                       pi.public_id,
                       'image_key',
                       pi.image_key,
                       'image_type',
                       pi.image_type,
                       'sort_order',
                       pi.sort_order,
                       'is_primary',
                       pi.is_primary,
                       'source',
                       pi.source
                     )
                     ORDER BY
                       pi.is_primary DESC,
                       pi.sort_order,
                       pi.created_at
                   )
                 FROM product_images pi
                 WHERE pi.product_id =
                       p.id
               ),
               '[]'::jsonb
             ) AS image_records
           FROM "Products" p
           LEFT JOIN brands b
             ON b.id = p.brand_id
           LEFT JOIN "NavLinks" n
             ON n.id =
                p.category_id
           LEFT JOIN inventory_summary inv
             ON inv.product_id = p.id
            AND inv.location_code = $2
           WHERE p.id = $1
           LIMIT 1`,
          [
            req.params.id,
            locationCode,
            customerType
          ]
        );

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            'Product not found'
        });
      }

      return res.json({
        product: result.rows[0]
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

router.put(
  '/:id',
  upload.array('images', 20),
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const body =
        req.body || {};

      const existingDirectImages =
        imageUrlsFromBody(body);

      const uploadedFiles =
        await uploadRequestFiles(
          req.files || [],
          body.sku ||
            imageIdentity(body) ||
            req.params.id
        );

      let images = null;

      if (uploadedFiles.length) {
        images = uploadedFiles;
      } else if (
        existingDirectImages.length
      ) {
        images =
          existingDirectImages.map(
            (url, index) => ({
              url,
              image_type:
                index === 0
                  ? 'PRIMARY'
                  : 'OTHER',
              source: 'URL'
            })
          );
      }

      await client.query('BEGIN');

      const product =
        await updateProduct(
          client,
          req.params.id,
          body,
          images
        );

      if (!product) {
        await client.query(
          'ROLLBACK'
        );

        return res.status(404).json({
          error:
            'Product not found'
        });
      }

      await client.query('COMMIT');

      return res.json({
        message:
          'Product updated',
        product
      });
    } catch (error) {
      await client.query(
        'ROLLBACK'
      );

      const status =
        error.status ||
        (
          String(error.code) ===
          '23505'
            ? 409
            : 500
        );

      return res.status(status).json({
        error: String(
          error.message || error
        )
      });
    } finally {
      client.release();
    }
  }
);

router.delete(
  '/:id',
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `UPDATE "Products"
           SET is_active = false,
               published = false,
               deleted_at =
                 COALESCE(
                   deleted_at,
                   NOW()
                 ),
               updated_at = NOW()
           WHERE id = $1
           RETURNING
             id,
             sku,
             name,
             is_active,
             published,
             deleted_at`,
          [req.params.id]
        );

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            'Product not found'
        });
      }

      return res.json({
        message:
          'Product archived',
        product: result.rows[0]
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

router.post(
  '/:id/restore',
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `UPDATE "Products"
           SET is_active = true,
               published =
                 COALESCE(
                   $2,
                   true
                 ),
               deleted_at = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING
             id,
             sku,
             name,
             is_active,
             published,
             deleted_at`,
          [
            req.params.id,
            req.body?.published ===
            undefined
              ? true
              : booleanValue(
                  req.body.published,
                  true
                )
          ]
        );

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            'Product not found'
        });
      }

      return res.json({
        message:
          'Product restored',
        product: result.rows[0]
      });
    } catch (error) {
      return res.status(500).json({
        error: String(
          error.message || error
        )
      });
    }
  }
);

module.exports = router;