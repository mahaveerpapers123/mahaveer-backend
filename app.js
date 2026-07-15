require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const navlinksRouter = require("./routes/navlinks");
const productsRouter = require("./routes/products");
const categoriesRouter = require("./routes/categories");
const brandsRouter = require("./routes/brands");
const authRouter = require("./routes/auth");
const uploadRouter = require("./routes/upload");
const ordersRouter = require("./routes/orders");
const checkoutRouter = require("./routes/checkout");
const reviewsRouter = require("./routes/reviews");
const adminRouter = require("./routes/admin");
const inventoryRouter = require("./routes/inventory");
const shippingRouter = require("./routes/shipping");
const trackingRouter = require("./routes/tracking");
const razorpayRouter = require("./routes/razorpay");

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://192.168.0.106:3000",
  "https://web-eta-taupe-31.vercel.app",
  "https://admin-mocha-omega.vercel.app",
  "https://mahaveerpaperenterprises-sand.vercel.app",
  "https://mahaveer-website-theta.vercel.app",
  "https://mahaveeronline.com",
  "https://www.mahaveeronline.com"
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      const error = new Error(`CORS blocked for origin: ${origin}`);
      error.statusCode = 403;
      return callback(error);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      "X-Razorpay-Signature",
      "X-Razorpay-Event-Id"
    ]
  })
);

app.use(
  "/api/razorpay/webhook",
  express.raw({
    type: "application/json",
    limit: "5mb"
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const isVercel = Boolean(process.env.VERCEL);
const uploadsPath = isVercel
  ? path.join("/tmp", "uploads")
  : path.join(__dirname, "uploads");

app.use("/uploads", express.static(uploadsPath));

const healthHandler = (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "API is running",
    timestamp: new Date().toISOString()
  });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

app.use("/api/navlinks", navlinksRouter);
app.use("/api/products", productsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/brands", brandsRouter);
app.use("/api/auth", authRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/shipping", shippingRouter);
app.use("/api/tracking", trackingRouter);
app.use("/api/razorpay", razorpayRouter);

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "API is running"
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    method: req.method,
    path: req.originalUrl
  });
});

app.use((err, _req, res, _next) => {
  console.error("[app] Unhandled error:", err);

  const statusCode = Number(err.statusCode || err.status) || 500;

  res.status(statusCode).json({
    error: statusCode === 403 ? "Origin is not allowed" : "Internal server error",
    detail:
      process.env.NODE_ENV === "production"
        ? undefined
        : String(err.message || err)
  });
});

const PORT = Number(process.env.PORT || 5000);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
