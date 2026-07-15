const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

function pick(primary, fallback) {
  return primary ?? fallback;
}

const endpoint = pick(process.env.SPACES_ENDPOINT, process.env.DO_SPACE_ENDPOINT);
const region = pick(process.env.SPACES_REGION, process.env.DO_SPACE_REGION) || 'us-east-1';
const accessKeyId = pick(process.env.SPACES_KEY, process.env.DO_SPACE_KEY);
const secretAccessKey = pick(process.env.SPACES_SECRET, process.env.DO_SPACE_SECRET);
const bucket = pick(process.env.SPACES_BUCKET, process.env.DO_SPACE_BUCKET);
const publicBase = pick(process.env.SPACES_PUBLIC_BASE, process.env.DO_SPACE_CDN_BASE);
const folder = pick(process.env.SPACES_FOLDER, process.env.DO_SPACE_FOLDER) || 'products';

function assertConfigured() {
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicBase) {
    throw new Error('DigitalOcean Spaces environment variables are missing');
  }
}

function safeName(value = '') {
  return String(value).trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '_').slice(-180) || 'file';
}

function client() {
  assertConfigured();
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: false,
    credentials: { accessKeyId, secretAccessKey }
  });
}

async function uploadBufferToSpaces(buffer, mimeType, originalName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Upload buffer is empty');
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const key = `${folder}/${id}-${safeName(originalName)}`;

  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
    ACL: 'public-read'
  }));

  return { key, url: `${String(publicBase).replace(/\/$/, '')}/${key}` };
}

module.exports = { uploadBufferToSpaces };
