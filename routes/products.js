const express = require('express');
const pool = require('../db');
const multer = require('multer');
const XLSX = require('xlsx');
const unzipper = require('unzipper');
const { v2: cloudinary } = require('cloudinary');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const clampPercent = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
};

const toNumberOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

const toNullIfZero = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? null : n;
};

const sanitizeHsn = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8) || null;

const sanitizeBarcode = (v) =>
  String(v || '')
    .trim()
    .replace(/[^0-9A-Za-z]/g, '')
    .slice(0, 64) || null;

const parseBoolean = (v, fallback = true) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const x = v.trim().toLowerCase();
    if (x === 'true') return true;
    if (x === 'false') return false;
  }
  return fallback;
};

const normalizeSlug = (v) =>
  String(v || '')
    .toLowerCase()
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeImageKey = (v) =>
  String(v || '')
    .toLowerCase()
    .trim()
    .replace(/\.[^/.]+$/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || null;

const safeJsonParse = (v, fallback) => {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

const textValue = (v) => String(v ?? '').trim();

const numberString = (v) => {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? String(n) : '';
};

const percentString = (v) => {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return '';
  const pct = n <= 1 ? n * 100 : n;
  return String(Math.max(0, Math.min(100, pct)));
};

const buildImageKey = ({ image_key, image_code, barcode, colour }) => {
  const existing = normalizeImageKey(image_key);
  if (existing) return existing;

  const explicit = normalizeImageKey(image_code);
  if (explicit) return explicit;

  const b = normalizeImageKey(barcode);
  const c = normalizeImageKey(colour);

  if (b && c) return `${b}-${c}`;
  if (b) return b;

  return null;
};

const getImageKeyFromFilePath = (entryPath) => {
  const fileName = String(entryPath || '').split('/').pop() || '';
  return normalizeImageKey(fileName);
};

const getBarcodeFromImageKey = (imageKey) => {
  const match = String(imageKey || '').match(/^([0-9]+)/);
  return match ? match[1] : null;
};

const imagesFromBody = (body) => {
  let urlImages = [];
  if (Array.isArray(body.imageUrls)) {
    urlImages = body.imageUrls.filter(Boolean);
  } else if (typeof body.imageUrls === 'string') {
    urlImages = body.imageUrls.trim().startsWith('data:')
      ? [body.imageUrls.trim()]
      : body.imageUrls.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const inlineImages = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
  return [...urlImages, ...inlineImages];
};

const cloudinaryReady = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );

const uploadToCloudinary = (buffer, mimeType, publicId, folder = 'mahaveer-products') =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });

const getCloudinaryImageByKey = async (imageKey, folder = 'mahaveer-products') => {
  const key = normalizeImageKey(imageKey);
  if (!key || !cloudinaryReady()) return null;
  try {
    const resource = await cloudinary.api.resource(`${folder}/${key}`, { resource_type: 'image' });
    return resource?.secure_url || null;
  } catch {
    return null;
  }
};

const getCloudinaryImageByHsn = async (hsnCode, folder = 'mahaveer-products') => {
  const hsn = sanitizeHsn(hsnCode);
  if (!hsn || !cloudinaryReady()) return null;
  try {
    const resource = await cloudinary.api.resource(`${folder}/${hsn}`, { resource_type: 'image' });
    return resource?.secure_url || null;
  } catch {
    return null;
  }
};

const ensureImages = async (body, fileUrls = []) => {
  const directImages = [...imagesFromBody(body), ...fileUrls].filter(Boolean);
  if (directImages.length > 0) return directImages;

  const imageKey = buildImageKey({
    image_key: body.image_key,
    image_code: body.image_code,
    barcode: body.barcode,
    colour: body.colour ?? body.color,
  });

  const imageByKey = await getCloudinaryImageByKey(imageKey);
  if (imageByKey) return [imageByKey];

  const fallbackImage = await getCloudinaryImageByHsn(body.hsn_code);
  return fallbackImage ? [fallbackImage] : [];
};

const validateProductPayload = (body) => {
  if (!body.name || !body.brand || !body.category_slug) {
    return 'Missing required fields: name, brand, category_slug';
  }

  const mahaveer_price = toNumberOrNull(body.mahaveer_price ?? body.price);
  const mrp = toNumberOrNull(body.mrp);
  const hsn_percentage = toNumberOrNull(body.hsn_percentage);
  const weight = toNumberOrNull(body.weight);
  const length = toNumberOrNull(body.length);
  const width = toNumberOrNull(body.width);
  const height = toNumberOrNull(body.height);

  if (mahaveer_price !== null && mahaveer_price < 0) return 'Mahaveer Price must be a non-negative number';
  if (mrp !== null && mrp < 0) return 'MRP must be a non-negative number';
  if (mrp !== null && mahaveer_price !== null && mrp < mahaveer_price) return 'MRP must be greater than or equal to Mahaveer Price';
  if (hsn_percentage !== null && (hsn_percentage < 0 || hsn_percentage > 100)) return 'HSN Percentage must be between 0 and 100';

  for (const [k, v] of Object.entries({ weight, length, width, height })) {
    if (v !== null && v < 0) return `${k} must be a non-negative number`;
  }

  return null;
};

const buildInsertValues = (body, allImages) => {
  const mahaveer_price = toNumberOrNull(body.mahaveer_price ?? body.price);
  const mrp = toNumberOrNull(body.mrp);
  const hsn_percentage = toNumberOrNull(body.hsn_percentage);
  const weight = toNumberOrNull(body.weight);
  const length = toNumberOrNull(body.length);
  const width = toNumberOrNull(body.width);
  const height = toNumberOrNull(body.height);
  const discount_b2b = clampPercent(body.discount_b2b);
  const discount_b2c = clampPercent(body.discount_b2c);
  const published = parseBoolean(body.published, true);
  const hsn_code = sanitizeHsn(body.hsn_code);
  const barcode = sanitizeBarcode(body.barcode);
  const colour = textValue(body.colour ?? body.color);
  const image_key = buildImageKey({
    image_key: body.image_key,
    image_code: body.image_code,
    barcode,
    colour,
  });

  return [
    body.name,
    body.model_name || null,
    body.brand,
    body.category_slug,
    hsn_code,
    hsn_percentage,
    mrp,
    mahaveer_price,
    discount_b2b,
    discount_b2c,
    weight,
    length,
    width,
    height,
    body.description || '',
    JSON.stringify(allImages || []),
    published,
    barcode,
    colour || null,
    image_key,
  ];
};

const insertProduct = async (db, body, allImages) => {
  const values = buildInsertValues(body, allImages);
  const result = await db.query(
    `INSERT INTO "Products"
      (name, model_name, brand, category_slug, hsn_code, hsn_percentage, mrp, mahaveer_price,
       discount_b2b, discount_b2c, weight, length, width, height, description, images, published,
       barcode, colour, image_key)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17,
       $18, $19, $20)
     RETURNING id`,
    values
  );
  return result.rows[0].id;
};

const linkProductImageByKey = async (db, rawImageKey, imageUrl) => {
  const imageKey = normalizeImageKey(rawImageKey);
  if (!imageKey || !imageUrl) {
    return {
      linkedProducts: 0,
      status: 'skipped',
      reason: 'Invalid image key or image URL',
    };
  }

  const exact = await db.query(
    `UPDATE "Products"
     SET images = $1::jsonb
     WHERE image_key = $2`,
    [JSON.stringify([imageUrl]), imageKey]
  );

  if (exact.rowCount > 0) {
    return {
      linkedProducts: exact.rowCount,
      status: 'linked',
      matchType: 'image_key',
    };
  }

  const barcode = getBarcodeFromImageKey(imageKey);

  if (!barcode) {
    return {
      linkedProducts: 0,
      status: 'unmatched',
      reason: 'No matching product image_key found',
    };
  }

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM "Products"
     WHERE barcode = $1`,
    [barcode]
  );

  const total = Number(countResult.rows[0]?.total || 0);

  if (total === 1) {
    const fallback = await db.query(
      `UPDATE "Products"
       SET images = $1::jsonb
       WHERE barcode = $2`,
      [JSON.stringify([imageUrl]), barcode]
    );

    return {
      linkedProducts: fallback.rowCount,
      status: 'linked',
      matchType: 'barcode_unique',
    };
  }

  if (total > 1) {
    return {
      linkedProducts: 0,
      status: 'ambiguous',
      reason: `Barcode ${barcode} exists on ${total} products. Rename image with colour or IMAGE CODE.`,
    };
  }

  return {
    linkedProducts: 0,
    status: 'unmatched',
    reason: `No product found for barcode ${barcode}`,
  };
};

const defaultHeaderForField = (headers, field) => {
  const lower = headers.map((h) => ({ raw: h, key: String(h).trim().toLowerCase() }));

  const findAny = (...names) => {
    for (const name of names) {
      const exact = lower.find((x) => x.key === name.toLowerCase());
      if (exact) return exact.raw;
    }
    for (const name of names) {
      const partial = lower.find((x) => x.key.includes(name.toLowerCase()));
      if (partial) return partial.raw;
    }
    return '';
  };

  switch (field) {
    case 'name':
      return findAny('ITEM NAME', 'PRODUCT NAME', 'NAME');
    case 'model_name':
      return findAny('ITEM CODE', 'MODEL NAME', 'CODE', 'SKU');
    case 'brand':
      return findAny('BRAND');
    case 'hsn_code':
      return findAny('HSN CODE', 'HSN');
    case 'hsn_percentage':
      return findAny('PERCENTAGE', 'GST %', 'GST PERCENTAGE', 'HSN PERCENTAGE');
    case 'mrp':
      return findAny('MRP');
    case 'mahaveer_price':
      return findAny('SALES RATE', 'SELLING RATE', 'S. RATE', 'W.S  RATE', 'W.S RATE', 'PURCHASE RATE', 'P RATE', 'P  RATE');
    case 'discount_b2b':
      return findAny('DISCOUNT B2B', 'B2B DISCOUNT');
    case 'discount_b2c':
      return findAny('DISCOUNT B2C', 'B2C DISCOUNT');
    case 'weight':
      return findAny('WEIGHT', 'REAM WEIGHT IN KG');
    case 'length':
      return findAny('LENGTH');
    case 'width':
      return findAny('WIDTH');
    case 'height':
      return findAny('HEIGHT');
    case 'description':
      return findAny('DESCRIPTION', 'ITEM NAME');
    case 'imageUrls':
      return findAny('PHOTO', 'IMAGE', 'IMAGE URL', 'IMAGEURLS');
    case 'barcode':
      return findAny('BARCODE', 'EAN', 'UPC');
    case 'colour':
      return findAny('COLOUR', 'COLOR');
    case 'image_code':
      return findAny('IMAGE CODE', 'IMAGE KEY', 'PHOTO CODE');
    default:
      return '';
  }
};

const buildDefaultMapping = (headers) => {
  const fields = [
    'name',
    'model_name',
    'brand',
    'hsn_code',
    'hsn_percentage',
    'mrp',
    'mahaveer_price',
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
  ];
  const mapping = {};
  for (const field of fields) {
    mapping[field] = defaultHeaderForField(headers, field);
  }
  return mapping;
};

const buildBulkPayloadFromRow = (row, sheetName, mapping, options) => {
  const categorySource = options.categorySource || 'sheet';
  const fixedCategorySlug = normalizeSlug(options.fixedCategorySlug || '');
  const categoryHeader = options.categoryHeader || '';

  let category_slug = '';
  if (categorySource === 'fixed') category_slug = fixedCategorySlug;
  else if (categorySource === 'group') category_slug = normalizeSlug(row['GROUP NAME']);
  else if (categorySource === 'header') category_slug = normalizeSlug(row[categoryHeader]);
  else category_slug = normalizeSlug(sheetName);

  const descriptionValue = textValue(row[mapping.description]);
  const barcode = textValue(row[mapping.barcode] ?? row['BARCODE']);
  const colour = textValue(row[mapping.colour] ?? row['COLOUR'] ?? row['COLOR']);
  const image_code = textValue(row[mapping.image_code] ?? row['IMAGE CODE']);
  const image_key = buildImageKey({ image_code, barcode, colour });

  const autoDescription = [
    textValue(row['GROUP NAME']),
    colour,
    textValue(row['UNIT']),
    barcode,
  ].filter(Boolean).join(' | ');

  const mrp = numberString(row[mapping.mrp]);
  const mahaveerPrice = numberString(row[mapping.mahaveer_price] ?? row[mapping.mrp]);
  const photo = textValue(row[mapping.imageUrls]);

  return {
    name: textValue(row[mapping.name]),
    model_name: textValue(row[mapping.model_name]),
    brand: textValue(row[mapping.brand]),
    category_slug,
    hsn_code: sanitizeHsn(row[mapping.hsn_code]),
    hsn_percentage: percentString(row[mapping.hsn_percentage]),
    mrp,
    mahaveer_price: mahaveerPrice || mrp,
    discount_b2b: percentString(row[mapping.discount_b2b]) || '0',
    discount_b2c: percentString(row[mapping.discount_b2c]) || '0',
    weight: numberString(row[mapping.weight]),
    length: numberString(row[mapping.length]),
    width: numberString(row[mapping.width]),
    height: numberString(row[mapping.height]),
    description: descriptionValue || autoDescription || textValue(row[mapping.name]) || '',
    imageUrls: photo,
    barcode,
    colour,
    image_code,
    image_key,
    published: parseBoolean(options.published, true),
  };
};

router.get('/ping-bulk', (_req, res) => {
  res.json({ ok: true, route: 'products routes working' });
});

router.post('/link-image-by-key', async (req, res) => {
  try {
    const imageKey = normalizeImageKey(req.body?.image_key);
    const imageUrl = String(req.body?.image_url || '').trim();

    if (!imageKey || !imageUrl) {
      return res.status(400).json({ error: 'image_key and image_url are required' });
    }

    const result = await linkProductImageByKey(pool, imageKey, imageUrl);

    return res.status(200).json({
      message: result.linkedProducts ? 'Image linked successfully' : 'Image uploaded but not linked',
      image_key: imageKey,
      image_url: imageUrl,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to link image' });
  }
});

router.post('/link-image-by-hsn', async (req, res) => {
  try {
    const imageKey = normalizeImageKey(req.body?.image_key || req.body?.hsn_code);
    const imageUrl = String(req.body?.image_url || '').trim();

    if (!imageKey || !imageUrl) {
      return res.status(400).json({ error: 'hsn_code/image_key and image_url are required' });
    }

    const result = await linkProductImageByKey(pool, imageKey, imageUrl);

    return res.status(200).json({
      message: result.linkedProducts ? 'Image linked successfully' : 'Image uploaded but not linked',
      hsn_code: sanitizeHsn(req.body?.hsn_code),
      image_key: imageKey,
      image_url: imageUrl,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to link image' });
  }
});

router.post('/upload-zip-images', upload.single('zipFile'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'ZIP file is required' });
  }

  if (!cloudinaryReady()) {
    return res.status(500).json({ error: 'Cloudinary environment variables are missing' });
  }

  let client;

  try {
    client = await pool.connect();

    const directory = await unzipper.Open.buffer(file.buffer);
    const uploaded = [];
    const skipped = [];
    let linkedProducts = 0;

    await client.query('BEGIN');

    for (const entry of directory.files) {
      if (entry.type !== 'File') continue;

      const entryPath = String(entry.path || '');
      const fileName = entryPath.split('/').pop();
      const ext = String(fileName || '').split('.').pop()?.toLowerCase();
      const allowed = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

      if (!fileName || !allowed.includes(ext)) {
        skipped.push({ file: entryPath, reason: 'Unsupported file type' });
        continue;
      }

      const imageKey = getImageKeyFromFilePath(entryPath);

      if (!imageKey) {
        skipped.push({ file: entryPath, reason: 'Invalid image filename' });
        continue;
      }

      const buffer = await entry.buffer();

      if (!buffer || !buffer.length) {
        skipped.push({ file: entryPath, reason: 'Empty file' });
        continue;
      }

      const mimeType =
        ext === 'png'
          ? 'image/png'
          : ext === 'webp'
          ? 'image/webp'
          : ext === 'avif'
          ? 'image/avif'
          : 'image/jpeg';

      try {
        const result = await uploadToCloudinary(buffer, mimeType, imageKey, 'mahaveer-products');
        const linkResult = await linkProductImageByKey(client, imageKey, result.secure_url);

        linkedProducts += Number(linkResult.linkedProducts || 0);

        uploaded.push({
          file: entryPath,
          image_key: imageKey,
          url: result.secure_url,
          public_id: result.public_id,
          linked_products: linkResult.linkedProducts,
          status: linkResult.status,
          match_type: linkResult.matchType || null,
          reason: linkResult.reason || null,
        });

        if (!Number(linkResult.linkedProducts || 0)) {
          skipped.push({
            file: entryPath,
            image_key: imageKey,
            reason: linkResult.reason || 'Image uploaded but no product linked',
          });
        }
      } catch (entryError) {
        skipped.push({
          file: entryPath,
          image_key: imageKey,
          reason: entryError?.message || 'Upload failed',
        });
      }
    }

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'ZIP images uploaded successfully',
      uploadedCount: uploaded.length,
      skippedCount: skipped.length,
      linkedProducts,
      uploaded,
      skipped,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    return res.status(500).json({
      error: error?.message || 'Failed to upload ZIP images',
    });
  } finally {
    if (client) client.release();
  }
});

router.post('/', upload.array('images'), async (req, res) => {
  try {
    const body = req.body;
    const validationError = validateProductPayload(body);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const allImages = await ensureImages(body, []);
    const id = await insertProduct(pool, body, allImages);

    return res.status(201).json({
      message: 'Product saved',
      id,
      images_found: allImages.length,
      image_source: allImages.length ? 'direct-or-cloudinary' : 'none',
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to save product' });
  }
});

router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Excel file is required' });
  }

  let client;

  try {
    const mapping = typeof req.body.mapping === 'string' ? safeJsonParse(req.body.mapping, {}) : req.body.mapping || {};
    const selectedSheets = typeof req.body.selectedSheets === 'string' ? safeJsonParse(req.body.selectedSheets, []) : req.body.selectedSheets || [];
    const options = {
      categorySource: req.body.categorySource || 'sheet',
      fixedCategorySlug: req.body.fixedCategorySlug || '',
      categoryHeader: req.body.categoryHeader || '',
      published: req.body.published,
    };

    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const rowsToInsert = [];
    const errors = [];

    for (const sheetName of workbook.SheetNames) {
      if (Array.isArray(selectedSheets) && selectedSheets.length && !selectedSheets.includes(sheetName)) {
        continue;
      }

      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' }).filter((row) =>
        Object.values(row || {}).some((v) => String(v ?? '').trim() !== '')
      );

      if (!rows.length) continue;

      const headers = Array.from(
        new Set(
          rows.reduce((acc, row) => {
            Object.keys(row || {}).forEach((k) => acc.push(String(k)));
            return acc;
          }, [])
        )
      );

      const finalMapping = { ...buildDefaultMapping(headers), ...mapping };

      rows.forEach((row, index) => {
        const payload = buildBulkPayloadFromRow(row, sheetName, finalMapping, options);
        const validationError = validateProductPayload(payload);

        if (validationError) {
          errors.push({
            sheet: sheetName,
            row: index + 2,
            name: payload.name || '',
            error: validationError,
          });
          return;
        }

        rowsToInsert.push({
          sheet: sheetName,
          rowNumber: index + 2,
          payload,
        });
      });
    }

    if (!rowsToInsert.length) {
      return res.status(400).json({
        error: 'No valid product rows found',
        total: 0,
        success: 0,
        failed: errors.length,
        errors,
      });
    }

    client = await pool.connect();
    let success = 0;

    try {
      await client.query('BEGIN');

      for (const item of rowsToInsert) {
        try {
          const imageList = await ensureImages(item.payload, []);
          await insertProduct(client, item.payload, imageList);
          success += 1;
        } catch (err) {
          errors.push({
            sheet: item.sheet,
            row: item.rowNumber,
            name: item.payload.name || '',
            error: err?.message || 'Failed to insert product',
          });
        }
      }

      await client.query('COMMIT');

      return res.status(201).json({
        message: 'Bulk upload completed',
        total: rowsToInsert.length,
        success,
        failed: errors.length,
        errors,
      });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      return res.status(500).json({ error: error?.message || 'Bulk upload failed' });
    }
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to process Excel file' });
  } finally {
    if (client) client.release();
  }
});

router.post('/bulk-json', async (req, res) => {
  let client;

  try {
    const products = Array.isArray(req.body.products) ? req.body.products : [];

    if (!products.length) {
      return res.status(400).json({ error: 'products array is required' });
    }

    client = await pool.connect();

    const errors = [];
    let success = 0;

    try {
      await client.query('BEGIN');

      for (let i = 0; i < products.length; i += 1) {
        const body = products[i] || {};
        const validationError = validateProductPayload(body);

        if (validationError) {
          errors.push({
            row: i + 1,
            name: body.name || '',
            error: validationError,
          });
          continue;
        }

        try {
          const imageList = await ensureImages(body, []);
          await insertProduct(client, body, imageList);
          success += 1;
        } catch (err) {
          errors.push({
            row: i + 1,
            name: body.name || '',
            error: err?.message || 'Failed to insert product',
          });
        }
      }

      await client.query('COMMIT');

      return res.status(201).json({
        message: 'Bulk import completed',
        total: products.length,
        success,
        failed: errors.length,
        errors,
      });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      return res.status(500).json({
        error: error?.message || String(error) || 'Bulk import failed',
      });
    }
  } catch (error) {
    return res.status(500).json({
      error: error?.message || String(error) || 'Failed to import products',
    });
  } finally {
    if (client) client.release();
  }
});

router.get('/resolve-image/:imageKey', async (req, res) => {
  try {
    const imageKey = normalizeImageKey(req.params.imageKey);
    const url = await getCloudinaryImageByKey(imageKey);
    return res.json({ image_key: imageKey, image: url });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to resolve image' });
  }
});

router.get('/', async (req, res) => {
  let { category = 'all', page = 1, limit = 20, brand, query } = req.query;

  const wantAll = String(category).toLowerCase() === 'all';
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const perPage = Math.max(1, parseInt(limit, 10) || 20);
  const offset = (pageNum - 1) * perPage;

  try {
    const params = [];
    let where = 'WHERE published = true';

    if (brand) {
      params.push(brand);
      where += ` AND brand = $${params.length}`;
    }

    if (!wantAll) {
      params.push(category);
      where += ` AND category_slug = $${params.length}`;
    }

    if (query) {
      params.push(`%${query}%`);
      where += ` AND (LOWER(name) LIKE LOWER($${params.length}) OR LOWER(description) LIKE LOWER($${params.length}))`;
    }

    params.push(perPage);
    const limitIdx = params.length;

    params.push(offset);
    const offsetIdx = params.length;

    const productsQuery = `
      SELECT id, name, model_name, brand, category_slug, hsn_code, hsn_percentage,
             mrp, mahaveer_price, discount_b2b, discount_b2c,
             weight, length, width, height,
             description, images, published, created_at,
             barcode, colour, image_key
      FROM "Products"
      ${where}
      ORDER BY created_at DESC
      LIMIT $${limitIdx}
      OFFSET $${offsetIdx}
    `;

    const products = await pool.query(productsQuery, params);

    const countParams = params.slice(0, limitIdx - 1);
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM "Products"
      ${where}
    `;

    const countResult = await pool.query(countQuery, countParams);
    const total = Number(countResult.rows[0].total);

    const items = (products.rows || []).map((r) => {
      const base = Number(r.mahaveer_price) || 0;
      const dB2B = clampPercent(r.discount_b2b);
      const dB2C = clampPercent(r.discount_b2c);
      const b2b_price = base ? Number((base * (1 - dB2B / 100)).toFixed(2)) : 0;
      const b2c_price = base ? Number((base * (1 - dB2C / 100)).toFixed(2)) : 0;
      return {
        ...r,
        weight: toNullIfZero(r.weight),
        length: toNullIfZero(r.length),
        width: toNullIfZero(r.width),
        height: toNullIfZero(r.height),
        b2b_price,
        b2c_price,
      };
    });

    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({
      page: pageNum,
      limit: perPage,
      total,
      items,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to fetch products from database' });
  }
});

module.exports = router;