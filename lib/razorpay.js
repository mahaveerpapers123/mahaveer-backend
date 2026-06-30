const crypto = require("crypto");
const Razorpay = require("razorpay");

function getClient() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Missing Razorpay credentials");
  }
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret
  });
}

function hmacHex(message, secret) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

async function createOrder(payload) {
  const client = getClient();
  return client.orders.create(payload);
}

async function fetchPayment(paymentId) {
  const client = getClient();
  return client.payments.fetch(paymentId);
}

async function fetchOrder(orderId) {
  const client = getClient();
  return client.orders.fetch(orderId);
}

function verifyCheckoutSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new Error("Missing Razorpay key secret");
  const expected = hmacHex(`${razorpay_order_id}|${razorpay_payment_id}`, secret);
  return expected === razorpay_signature;
}

function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing Razorpay webhook secret");
  if (!signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expected = hmacHex(body, secret);
  return expected === signature;
}

module.exports = {
  createOrder,
  fetchPayment,
  fetchOrder,
  verifyCheckoutSignature,
  verifyWebhookSignature
};