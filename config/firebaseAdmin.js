const admin = require("firebase-admin");

let cachedAdmin = null;

function getFirebaseAdmin() {
  if (cachedAdmin) {
    return cachedAdmin;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : null;

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      })
    });
  }

  cachedAdmin = admin;
  return cachedAdmin;
}

module.exports = getFirebaseAdmin;