require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

const navlinksRouter = require("./routes/navlinks");
const prodlinksRouter = require("./routes/products");
const categoriesRouter = require("./routes/categories");
const authRouter = require("./routes/auth");
const uploadRoute = require("./routes/upload");
const ordersRouter = require("./routes/orders");
const checkoutRouter = require("./routes/checkout");
const reviewsRouter = require("./routes/reviews");
const adminRouter = require("./routes/admin");
const shippingRouter = require("./routes/shipping");
const trackingRouter = require("./routes/tracking");
const razorpayRouter = require("./routes/razorpay");

const allowedOrigins = [
  "http://localhost:3000",
  "http://192.168.0.106:3000",
  "http://localhost:3001",
  "https://web-eta-taupe-31.vercel.app",
  "https://admin-mocha-omega.vercel.app",
  "https://mahaveerpaperenterprises-sand.vercel.app",
  "https://mahaveer-website-theta.vercel.app",
  "https://mahaveeronline.com"
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true
  })
);

app.use("/api/razorpay/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const isVercel = !!process.env.VERCEL;
const uploadsPath = isVercel ? path.join("/tmp", "uploads") : path.join(__dirname, "uploads");
app.use("/uploads", express.static(uploadsPath));

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "API is running"
  });
});

app.use("/api/navlinks", navlinksRouter);
app.use("/api/products", prodlinksRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/auth", authRouter);
app.use("/api/upload", uploadRoute);
app.use("/api/orders", ordersRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/shipping", shippingRouter);
app.use("/api/tracking", trackingRouter);
app.use("/api/razorpay", razorpayRouter);

app.get("/", (_req, res) => {
  res.status(200).send("API is running");
});

app.use((err, _req, res, _next) => {
  console.error("[app] Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    detail: process.env.NODE_ENV === "production" ? undefined : String(err.message || err)
  });
});

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
