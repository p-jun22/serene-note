// backend/middlewares/authMiddleware.js
const { admin } = require('../firebaseAdmin');

async function authMiddleware(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!token) return res.status(401).json({ ok: false, error: 'missing_bearer_token' });

    const decoded = await admin.auth().verifyIdToken(token /*, true */);
    req.user = { uid: decoded.uid, email: decoded.email || null, name: decoded.name || null };
    next();
  } catch (e) {
    console.error('authMiddleware error:', e?.code || e?.message || e);
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

module.exports = { authMiddleware };
