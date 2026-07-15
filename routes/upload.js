const express = require('express');
const multer = require('multer');
const { uploadBufferToSpaces } = require('../lib/spaces');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!String(req.file.mimetype || '').startsWith('image/')) return res.status(415).json({ error: 'Only image files are allowed' });

    const result = await uploadBufferToSpaces(req.file.buffer, req.file.mimetype, req.file.originalname);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: 'Upload failed', detail: String(error.message || error) });
  }
});

module.exports = router;
