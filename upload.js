const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();

const fs = require('fs');

const productsDir = path.join(__dirname, '..', 'uploads', 'products');
if (!fs.existsSync(productsDir)) fs.mkdirSync(productsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads', 'products'));
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only image files allowed'), ok);
  }
});

// POST /api/upload/product-image
router.post('/product-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const imageUrl = `/uploads/products/${req.file.filename}`;
  res.json({ imageUrl }); // save this path in MongoDB against the product
});

module.exports = router;