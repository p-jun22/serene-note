// backend/routes/api.js
// ─────────────────────────────────────────────────────────────────────────────
// 레거시 제거 + 필드명 호환(dateKey|sessionId, text|content|message.text, cid|conversationId)
// 더미(시드) 메시지 생성 없음
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const axios = require('axios');
const router = express.Router();

router.use(express.json()); // body 파서

const { authMiddleware } = require('../middlewares/authMiddleware');
const { admin, db } = require('../firebaseAdmin');
const repo = require('../services/firestoreRepository');
const gpt = require('../services/gptService');

const HF_BASE = process.env.HF_BASE_URL || process.env.HF_SERVER || 'http://127.0.0.1:5001';
const ADMIN_EMAIL = 'admin@gmail.com';
const BASELINE_EMAIL = 'basic@gmail.com';

const ymd = (s) => String(s || '').slice(0, 10);
const fail = (res, code, error, detail) => {
  if (detail) console.error('[api]', error, detail);
  return res.status(code).json({ ok: false, error });
};

router.use((req, _res, next) => {
  console.log('[api]', req.method, req.originalUrl);
  next();
});

// ─────────────────────────────────────────────
// 0) 헬스체크
// ─────────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ ok: true, api: true }));

router.get('/models/strength/health', authMiddleware, async (_req, res) => {
  try {
    const r = await axios.get(`${HF_BASE}/health`, { timeout: 5000 });
    return res.json({ ok: true, hf: r.data?.ok === true });
  } catch {
    return res.json({ ok: true, hf: false });
  }
});

// ─────────────────────────────────────────────
// 1) Messages
// ─────────────────────────────────────────────

/**
 * POST /api/messages
 * body: { sessionId|dateKey, conversationId|cid, text|content|message.text, correlationId? }
 * - assistant 메시지 저장 전용
 * - text가 비어 있으면 저장을 건너뛰고 200 OK(skipped)로 응답
 */
router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;

    // 필드명 호환 + message 래퍼 호환
    const sessionIdRaw =
      req.body?.sessionId ??
      req.body?.dateKey ??
      req.query?.sessionId ??
      req.query?.dateKey;

    const conversationId = String(
      req.body?.conversationId ??
      req.body?.cid ??
      req.body?.message?.conversationId ??
      ''
    ).trim();

    const rawText = req.body?.text ?? req.body?.content ?? req.body?.message?.text;
    const text = (rawText == null ? '' : String(rawText)).trim();
    const correlationId = req.body?.correlationId ? String(req.body.correlationId) : undefined;
    const conversationTitle = req.body?.conversationTitle ?? null;

    const sessionId = ymd(sessionIdRaw || '');
    if (!uid || !sessionId || !conversationId) {
      return fail(res, 400, 'bad_params', { uid: !!uid, sessionId, conversationId });
    }

    // 비어 있는 assistant 응답은 저장하지 않고 OK로 스킵 (프론트 전송 실패 방지)
    if (!text) {
      console.log('[api] /messages skipped: empty text');
      return res.json({ ok: true, skipped: 'empty_text' });
    }

    // (옵션) 멱등: correlationId 중복 방지
    if (correlationId && typeof repo.findAssistantByCorrelation === 'function') {
      const dup = await repo.findAssistantByCorrelation({ uid, sessionId, conversationId, correlationId });
      if (dup) return res.json({ ok: true, dedup: true });
    }

    await repo.addMessage({
      uid,
      sessionId,
      conversationId,
      conversationTitle,
      message: { role: 'assistant', text, lastBot: true, correlationId },
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, 'messages_create_failed', err);
  }
});

/**
 * GET /api/conversations/:conversationId/messages?sessionId=YYYY-MM-DD&limit=1000
 */
router.get('/conversations/:conversationId/messages', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const conversationId = String(req.params.conversationId || '');
    const sessionId = ymd(req.query.sessionId || req.query.dateKey || '');
    const limit = Number(req.query.limit || 1000);
    if (!uid || !sessionId || !conversationId) return fail(res, 400, 'bad_params');

    const rows = await repo.listMessages({ uid, sessionId, conversationId, limit });
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return fail(res, 500, 'messages_list_failed', err);
  }
});

/**
 * PATCH /api/messages/:messageId
 * body: { sessionId|dateKey, conversationId, text }
 */
router.patch('/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const messageId = String(req.params.messageId || '');
    const sessionId = ymd(req.body?.sessionId || req.body?.dateKey || '');
    const conversationId = String(req.body?.conversationId || '').trim();
    const text = String(req.body?.text ?? '').trim();

    if (!uid || !sessionId || !conversationId || !messageId || typeof text !== 'string') {
      return fail(res, 400, 'bad_params');
    }

    await repo.updateMessageText(uid, sessionId, conversationId, messageId, text);
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 500, 'message_update_failed', e);
  }
});

/**
 * POST /api/messages/:messageId/rate
 * body: { sessionId|dateKey, conversationId, rating:number(0..5) }
 */
router.post('/messages/:messageId/rate', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const messageId = String(req.params.messageId || '');
    const sessionId = ymd(req.body?.sessionId || req.body?.dateKey || '');
    const conversationId = String(req.body?.conversationId || '').trim();
    const rating = Number(req.body?.rating);

    if (!uid || !sessionId || !conversationId || !messageId || Number.isNaN(rating)) {
      return fail(res, 400, 'bad_params');
    }

    if (typeof repo.setUserRating === 'function') {
      await repo.setUserRating({ uid, sessionId, conversationId, messageId, rating });
    } else {
      const ref = db.doc(`users/${uid}/sessions/${sessionId}/conversations/${conversationId}/messages/${messageId}`);
      await ref.set({ userRating: rating }, { merge: true });
    }

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, 'message_rate_failed', err);
  }
});

// ─────────────────────────────────────────────
// 2) Conversations (목록/생성/수정/삭제) — 더미 메시지 없음
// ─────────────────────────────────────────────

router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const sessionId = ymd(req.query.sessionId || req.query.dateKey || '');
    const limit = Number(req.query.limit || 500);
    if (!uid || !sessionId) return fail(res, 400, 'bad_params');

    const list = await repo.listConversations({ uid, sessionId, limit });
    return res.json({ ok: true, data: list });
  } catch (err) {
    return fail(res, 500, 'conversations_list_failed', err);
  }
});

router.get('/conversations/:id', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const sessionId = ymd(req.query.sessionId || req.query.dateKey || '');
    const conversationId = String(req.params.id || '');
    if (!uid || !sessionId || !conversationId) return fail(res, 400, 'bad_params');

    const rows = await repo.listConversations({ uid, sessionId, limit: 1000 });
    const one = rows.find((r) => r.id === conversationId) || null;
    return res.json({ ok: true, data: one });
  } catch (e) {
    return fail(res, 500, 'get_conversation_failed', e);
  }
});

router.post('/conversations', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const sessionId = ymd(req.body?.sessionId || req.body?.dateKey || '');
    const cid = String(req.body?.conversationId || require('crypto').randomUUID());
    const title = String(req.body?.title || `${sessionId} 대화`);

    if (!uid || !sessionId) return fail(res, 400, 'bad_params');

    const now = admin.firestore.FieldValue.serverTimestamp();
    const convRef = db.doc(`users/${uid}/sessions/${sessionId}/conversations/${cid}`);
    await convRef.set(
      {
        id: cid,
        uid,
        dateKey: sessionId,
        title,
        createdAt: now,
        updatedAt: now,
        moodEmoji: null,
        moodLabels: [],
        distortions: [],
        coreBeliefs: [],
        lastBotAt: null,
        lastMsgAt: null,
        msgCount: 0,
        userMsgCount: 0,
      },
      { merge: true }
    );

    const items = await repo.listConversations({ uid, sessionId, limit: 500 });
    return res.json({ ok: true, id: cid, data: items });
  } catch (e) {
    return fail(res, 500, 'conversation_create_failed', e);
  }
});

router.put('/conversations/:conversationId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const conversationId = String(req.params.conversationId);
    const sessionId = ymd(req.body?.sessionId || req.body?.dateKey || '');
    const title = String(req.body?.title || '').trim();
    if (!uid || !sessionId || !conversationId || !title) return fail(res, 400, 'bad_params');

    await repo.updateConversationTitle({ uid, sessionId, conversationId, title });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, 'conversation_update_failed', err);
  }
});

router.patch('/conversations/:conversationId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const conversationId = String(req.params.conversationId);
    const sessionId = ymd(
      req.query.sessionId ||
      req.query.dateKey ||
      req.body?.sessionId ||
      req.body?.dateKey ||
      ''
    );
    const { title, note } = req.body || {};
    if (!uid || !conversationId || !sessionId) return fail(res, 400, 'bad_params');

    if (typeof title === 'string' && title.trim()) {
      await repo.updateConversationTitle({
        uid,
        sessionId,
        conversationId,
        title: String(title).trim(),
      });
    }

    const patch = {};
    if (typeof note === 'string') patch.note = String(note).trim();
    if (Object.keys(patch).length) {
      await repo.updateConversationMeta({ uid, dateKey: sessionId, conversationId, patch });
    }

    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 500, 'update_conversation_failed', e);
  }
});

router.delete('/conversations/:conversationId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const conversationId = String(req.params.conversationId);
    const sessionId = ymd(
      req.query.sessionId ||
      req.query.dateKey ||
      req.body?.sessionId ||
      req.body?.dateKey ||
      ''
    );
    if (!uid || !sessionId || !conversationId) return fail(res, 400, 'bad_params');

    await repo.deleteConversationCascade({ uid, sessionId, conversationId });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, 'conversation_delete_failed', err);
  }
});

// ─────────────────────────────────────────────
// 3) Calendar / Emotions / Day-first-inputs
// ─────────────────────────────────────────────
router.get('/calendar', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const startDateKey = req.query.startDateKey ? ymd(req.query.startDateKey) : (req.query.from ? ymd(req.query.from) : undefined);
    const endDateKey = req.query.endDateKey ? ymd(req.query.endDateKey) : (req.query.to ? ymd(req.query.to) : undefined);
    if (!uid) return fail(res, 400, 'bad_params');

    const data = await repo.getCalendar({ uid, startDateKey, endDateKey });
    return res.json({ ok: true, data });
  } catch (err) {
    return fail(res, 500, 'calendar_failed', err);
  }
});

router.get('/calendar/:dateKey', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const dateKey = ymd(req.params.dateKey);
    if (!uid || !dateKey) return fail(res, 400, 'bad_params');

    const map = await repo.getCalendar({ uid, startDateKey: dateKey, endDateKey: dateKey });
    return res.json({ ok: true, data: map?.[dateKey] || null });
  } catch (err) {
    return fail(res, 500, 'calendar_failed', err);
  }
});

router.get('/emotions', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const from = ymd(req.query.from);
    const to = ymd(req.query.to);
    if (!uid || !from || !to) return fail(res, 400, 'bad_params');

    const map = await repo.getCalendar({ uid, startDateKey: from, endDateKey: to });
    const byDate = {};

    for (const [k, v] of Object.entries(map)) {
      const counts = v.moodCounters || {};
      const expanded = [];
      Object.entries(counts).forEach(([label, n]) => {
        for (let i = 0; i < (n || 0); i++) expanded.push(label);
      });
      byDate[k] = {
        emotions: expanded,
        counts,
        emoji: v.topEmoji || v.lastEmoji || v.emoji || null,
        count: v.count || (v.convSet ? Object.keys(v.convSet).length : 0),
      };
    }

    res.json({ ok: true, byDate, data: { byDate } });
  } catch (e) {
    return fail(res, 500, 'emotions_query_failed', e);
  }
});

router.get('/days/:dateKey/first-user-inputs', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const dateKey = ymd(req.params.dateKey);
    if (!uid || !dateKey) return fail(res, 400, 'bad_params');

    const convCol = db.collection(`users/${uid}/sessions/${dateKey}/conversations`);
    const convSnap = await convCol.get();

    const out = [];
    const jobs = convSnap.docs.map(async (c) => {
      const cid = c.id;
      const msgCol = convCol.doc(cid).collection('messages');
      const snap = await msgCol.orderBy('createdAt', 'asc').limit(20).get();

      let first = null;
      snap.forEach((m) => {
        const v = m.data() || {};
        if (!first && (v.role === 'user' || v.sender === 'user')) {
          first = {
            conversationId: cid,
            firstUserText: v.text || v.content || '',
            firstUserAt: v.createdAt || v.created_at || null,
            firstMessageId: m.id,
          };
        }
      });

      if (first && (first.firstUserText || '').trim()) out.push(first);
    });

    await Promise.all(jobs);
    res.json({ ok: true, data: out });
  } catch (e) {
    return fail(res, 500, 'first_user_inputs_failed', e);
  }
});

// ─────────────────────────────────────────────
// 4) Models / Analysis
// ─────────────────────────────────────────────
router.post('/gpt/analyze', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid || null;
    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const dateKey = ymd(req.body?.dateKey || req.body?.sessionId || '');
    const conversationId = String(req.body?.conversationId || req.body?.cid || '').trim();
    const textRaw = (req.body?.text ?? req.body?.input ?? '');
    const text = String(textRaw).replace(/\s+/g, ' ').trim();
    const clientMessageId = req.body?.clientMessageId ? String(req.body.clientMessageId) : null;

    if (!dateKey || !conversationId) return fail(res, 400, 'bad_params', { dateKey, conversationId });
    if (!text) return res.status(400).json({ ok: false, error: 'text_required' });

    // 멱등: clientMessageId 중복 시 기존 결과 반환
    if (clientMessageId && typeof repo.findUserMessageByClientKey === 'function') {
      const dup = await repo.findUserMessageByClientKey({
        uid,
        sessionId: dateKey,
        conversationId,
        clientMessageId,
      });
      if (dup) {
        const msgRef = db.doc(`users/${uid}/sessions/${dateKey}/conversations/${conversationId}/messages/${dup.id}`);
        const snap = await msgRef.get();
        const data = snap.data() || {};
        return res.json({
          ok: true,
          analysisSnapshot_v1: data.analysisSnapshot_v1 || null,
          hf_raw: data.hf_raw || null,
          dedup: true,
        });
      }
    }

    const email = (req.user?.email || '').toLowerCase();
    const isBaseline = email === BASELINE_EMAIL;
    const isAdmin = !isBaseline && (email === ADMIN_EMAIL);
    const isGeneral = !isBaseline && !isAdmin;

    let userCount = 0;
    if (typeof repo.countUserMessages === 'function') {
      userCount = await repo.countUserMessages({ uid, sessionId: dateKey, conversationId });
    }

    const enableCoaching = (!isBaseline) && (userCount >= 1);
    const enableCorrection = (!isBaseline);
    const mode = isBaseline ? 'baseline' : (isAdmin ? 'admin' : 'user');
    const safetyOn = isGeneral;

    const prevSnapshot =
      (typeof repo.getLastUserSnapshot === 'function')
        ? await repo.getLastUserSnapshot({ uid, sessionId: dateKey, conversationId })
        : null;

    const { snapshot, hf_raw, usedPrompts, suggestRetry } = await gpt.analyzeMessage({
      uid,
      dateKey,
      conversationId,
      userText: text,
      mode,
      enableCoaching,
      enableCorrection,
      safetyOn,
      prevSnapshot,
    });

    // 스냅샷/ HF 를 message 안에 넣어서 저장 (repo.addMessage는 message.*만 읽음)
    await repo.addMessage({
      uid,
      sessionId: dateKey,
      conversationId,
      message: { role: 'user', text, clientMessageId, analysisSnapshot_v1: snapshot, hf_raw },
    });

    return res.json({
      ok: true,
      analysisSnapshot_v1: snapshot,
      hf_raw: hf_raw ?? null,

      // ⬇ 회귀 방지를 위해 상위 레벨도 유지
      usedPrompts,
      suggestRetry: !!suggestRetry,

      // ⬇ 프런트 분기/분석용 메타
      meta: {
        pipeline: mode,               // 'baseline' | 'user' | 'admin'
        coaching: enableCoaching,     // 두 번째 user 부터 true
        correction: enableCorrection, // baseline이면 false, 그 외 true
        isAdmin,                      // 디버깅/표시용(선택)
        usedPrompts,                  // 중복 포함 OK
        suggestRetry: !!suggestRetry,
      },
    });
  } catch (e) {
    console.error('[api] /gpt/analyze failed:', e);
    return res.status(500).json({
      ok: false,
      error: 'gpt_analyze_failed',
      message: e?.message || 'internal_error',
    });
  }
});

// ─────────────────────────────────────────────
// 5) Calibration / Feedback
// ─────────────────────────────────────────────
router.get('/models/calibration/profile', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return fail(res, 401, 'auth_required');
    if (typeof repo.getCalibrationProfile !== 'function') return res.json({ ok: true, profile: null });

    const profile = await repo.getCalibrationProfile(uid);
    return res.json({ ok: true, profile });
  } catch (e) {
    return fail(res, 500, 'calibration_profile_failed', e);
  }
});

router.post('/models/calibration/profile', authMiddleware, async (req, res) => {
  try {
    const email = (req.user?.email || '').toLowerCase();
    const isAdmin = email === ADMIN_EMAIL;
    if (!isAdmin) return fail(res, 403, 'forbidden');

    const uid = req.user?.uid;
    const profile = req.body?.profile;
    if (!uid || !profile) return fail(res, 400, 'bad_params');
    if (typeof repo.setCalibrationProfile !== 'function') return res.json({ ok: false, error: 'not_supported' });

    await repo.setCalibrationProfile(uid, profile);
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 500, 'calibration_profile_set_failed', e);
  }
});

router.post('/feedback', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { messageId, ...payload } = req.body || {};
    if (!uid || !messageId) return fail(res, 400, 'bad_params');

    if (typeof repo.upsertFeedback !== 'function') {
      return res.json({ ok: false, error: 'not_supported' });
    }

    const r = await repo.upsertFeedback(uid, String(messageId), payload);
    return res.json({ ok: true, upserted: r.upserted, existed: r.existed });
  } catch (e) {
    return fail(res, 500, 'feedback_upsert_failed', e);
  }
});

router.get('/feedback/count', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return fail(res, 401, 'auth_required');
    if (typeof repo.countFeedbackSamples !== 'function') return res.json({ ok: true, count: 0 });

    const { count } = await repo.countFeedbackSamples(uid);
    return res.json({ ok: true, count });
  } catch (e) {
    return fail(res, 500, 'feedback_count_failed', e);
  }
});

module.exports = router;
