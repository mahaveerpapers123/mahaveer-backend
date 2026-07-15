function captureRawBody(req, _res, buffer) {
  if (buffer?.length) req.rawBody = Buffer.from(buffer);
}

module.exports = captureRawBody;
