// backend/authMiddleware.js
const admin = require('../firebaseAdmin');

async function authMiddleware(req, res, next) {
  try {
    // 프론트 axios가 Bearer 토큰을 붙임 (쿠키 세션 아님)
    // 프론트 코드: src/api.js 인터셉터 참고
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing bearer token' });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };
    return next();
  } catch (e) {
    console.error('authMiddleware error', e);
    return res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { authMiddleware };
