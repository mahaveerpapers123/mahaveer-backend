const express = require('express');
const captureRawBody = require('../middleware/captureRawBody');

function registerRoutes(app) {
  app.use(express.json({ limit: '10mb', verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use('/api/admin', require('./admin'));
  app.use('/api/auth', require('./auth'));
  app.use('/api/categories', require('./categories'));
  app.use('/api/checkout', require('./checkout'));
  app.use('/api/navlinks', require('./navlinks'));
  app.use('/api/orders', require('./orders'));
  app.use('/api/products', require('./products'));
  app.use('/api/razorpay', require('./razorpay'));
  app.use('/api/reviews', require('./reviews'));
  app.use('/api/shipping', require('./shipping'));
  app.use('/api/tracking', require('./tracking'));
  app.use('/api/upload', require('./upload'));
  app.use('/api/inventory', require('./inventory'));
}

module.exports = registerRoutes;
