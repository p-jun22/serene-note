// backend/routes/dataRoutes.js
const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middlewares/authMiddleware');
const admin = require('../firebaseAdmin');
const { db } = require('../firebaseAdmin');

// YYYY-MM-DD 보정
function ymdKey(str) {
  return String(str || '').slice(0, 10);
}

/**
 * GET /api/calendar?startDateKey&endDateKey
 */
router.get('/calendar', authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const startDateKey = req.query.startDateKey ? ymdKey(req.query.startDateKey) : undefined;
    const endDateKey   = req.query.endDateKey   ? ymdKey(req.query.endDateKey)   : undefined;

    let q = db.collection('users').doc(uid).collection('calendar')
      .orderBy(admin.firestore.FieldPath.documentId());
    if (startDateKey) q = q.startAt(startDateKey);
    if (endDateKey)   q = q.endAt(endDateKey);

    const snap = await q.get();
    const out = {};
    snap.forEach(d => { out[d.id] = d.data(); });
    res.json({ uid, range: { startDateKey, endDateKey }, data: out });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/calendar/:dateKey
 */
router.get('/calendar/:dateKey', authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const dateKey = ymdKey(req.params.dateKey);
    const doc = await db.collection('users').doc(uid)
      .collection('calendar').doc(dateKey).get();
    res.json({ dateKey, ...(!doc.exists ? {} : doc.data()) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/emotions?from&to
 */
router.get('/emotions', authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const from = req.query.from ? ymdKey(req.query.from) : undefined;
    const to   = req.query.to   ? ymdKey(req.query.to)   : undefined;

    let q = db.collection('users').doc(uid).collection('calendar')
      .orderBy(admin.firestore.FieldPath.documentId());
    if (from) q = q.startAt(from);
    if (to)   q = q.endAt(to);

    const snap = await q.get();
    const rows = [];
    snap.forEach(d => {
      const v = d.data() || {};
      rows.push({ dateKey: d.id, count: v.count || 0, topEmoji: v.topEmoji || '📝' });
    });

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/messages
 *   body: { sessionId, conversationId, message: { role, text, analysisSnapshot_v1, userRating? } }
 */
const repo = require('../services/firestoreRepository');
router.post('/messages', authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const { sessionId, conversationId, message } = req.body || {};
    if (!sessionId || !conversationId || !message || !message.role || !message.text) {
      return res.status(400).json({ error: 'sessionId, conversationId, message{role,text} are required' });
    }

    const saved = await repo.addMessage({ uid, sessionId, conversationId, message });
    res.json({ ok: true, saved });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/messages/:messageId/rate
 */
router.post('/messages/:messageId/rate', authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const { messageId } = req.params;
    const { sessionId, conversationId, rating } = req.body || {};

    if (!sessionId || !conversationId || !messageId || typeof rating !== 'number') {
      return res.status(400).json({ error: 'sessionId, conversationId, messageId, rating are required' });
    }

    await repo.setUserRating({ uid, sessionId, conversationId, messageId, rating });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * ✅ 과거 호환: POST /api/messages/send
 *   - 형식 A: { sessionId, conversationId, text }
 *   - 형식 B: { sessionId, conversationId, message:{ role, text, analysisSnapshot_v1? } }
 *   → 내부적으로 형식 B로 변환하여 저장
 */
router.post('/messages/send', authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const { sessionId, conversationId } = req.body || {};

    // 1) 바디 표준화
    let msg = req.body?.message;
    if (!msg) {
      // 형식 A 처리
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (text) {
        msg = { role: 'user', text };
      }
    }

    if (!sessionId || !conversationId || !msg || !msg.role || !msg.text) {
      return res.status(400).json({
        error: 'bad_body',
        detail: 'Expected { sessionId, conversationId, message:{role,text} } or { sessionId, conversationId, text }'
      });
    }

    // 2) 저장
    const saved = await repo.addMessage({
      uid,
      sessionId,
      conversationId,
      message: {
        role: msg.role,
        text: msg.text,
        analysisSnapshot_v1: msg.analysisSnapshot_v1 || null
      }
    });

    res.json({ ok: true, saved, alias: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
