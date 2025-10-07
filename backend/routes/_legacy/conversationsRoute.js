// backend/routes/conversationsRoute.js
// 단일 라우터로 CRUD/조회 통합
// 경로 스키마(확정):
// users/{uid}/sessions/{dateKey}/conversations/{conversationId}/messages/{messageId}
// users/{uid}/sessions/{dateKey}/conversations/{conversationId}/stats
// users/{uid}/sessions/{dateKey}/calendar

const express = require('express');
const router = express.Router();

const repo = require('../services/firestoreRepository'); // 방금 수정한 파일
const { authMiddleware } = require('../middlewares/authMiddleware');

// ────────────────────────────────────────────────
// 작은 유틸
// ────────────────────────────────────────────────
function ok(res, data) { return res.json(data ?? { ok: true }); }
function bad(res, msg) { return res.status(400).json({ error: 'bad_request', detail: msg }); }
function err(res, code, e) {
  console.error(code, e);
  return res.status(500).json({ error: code, detail: String(e?.message || e) });
}

// ────────────────────────────────────────────────
// Conversations
// ────────────────────────────────────────────────

// Create(또는 존재 시 no-op) + 첫 메시지는 /messages 에서 처리
// POST /api/conversations
// body: { sessionId: "YYYY-MM-DD", conversationId?(선택), title?(선택) }
router.post('/conversations', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { sessionId, conversationId, title } = req.body || {};
    if (!uid || !sessionId) return bad(res, 'missing sessionId');

    // 대화 목록만 필요하면 listConversations 사용 권장.
    // 여기서는 "빈 대화"를 하나 미리 만들 때 사용.
    await repo.addMessage({
      uid,
      sessionId,
      conversationId: conversationId || require('crypto').randomUUID(),
      conversationTitle: title || `${sessionId} 대화`,
      message: { role: 'assistant', text: '(대화 생성)' } // assistant는 snapshot/hf_raw 자동 제거됨
    });

    return ok(res, { ok: true });
  } catch (e) {
    return err(res, 'conversation_create_failed', e);
  }
});

// List
// GET /api/conversations?sessionId=YYYY-MM-DD&limit=50
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const sessionId = String(req.query.sessionId || '');
    const limit = Number(req.query.limit || 100);
    if (!uid || !sessionId) return bad(res, 'missing sessionId');

    const rows = await repo.listConversations({ uid, sessionId, limit });
    return ok(res, { data: rows });
  } catch (e) {
    return err(res, 'conversation_list_failed', e);
  }
});

// Update (제목/요약 메타)
// PATCH /api/conversations/:dateKey/:convId
// body: { title?, moodEmoji?, moodLabels?, distortions?, coreBeliefs? }
router.patch('/conversations/:dateKey/:convId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { dateKey, convId } = req.params;
    const updates = req.body || {};
    if (!uid || !dateKey || !convId) return bad(res, 'missing params');

    await repo.updateConversationTitle({ uid, sessionId: dateKey, conversationId: convId, title: updates.title ?? undefined });
    // 추가 메타 필드도 함께 반영하고 싶다면 updateConversation 메서드를 더 노출해 사용해도 됨.
    if (updates.moodEmoji || updates.moodLabels || updates.distortions || updates.coreBeliefs) {
      await repo.updateConversation({
        uid, sessionId: dateKey, conversationId: convId, updates
      });
    }

    return ok(res);
  } catch (e) {
    return err(res, 'conversation_update_failed', e);
  }
});

// Delete (messages + stats + conversation 삭제) + calendar 재계산
// DELETE /api/conversations/:dateKey/:convId
router.delete('/conversations/:dateKey/:convId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { dateKey, convId } = req.params;
    if (!uid || !dateKey || !convId) return bad(res, 'missing params');

    await repo.deleteConversationCascade({ uid, sessionId: dateKey, conversationId: convId });
    return ok(res);
  } catch (e) {
    return err(res, 'conversation_delete_failed', e);
  }
});

// ────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────

// List
// GET /api/messages?sessionId=YYYY-MM-DD&conversationId=...
router.get('/messages', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const sessionId = String(req.query.sessionId || '');
    const conversationId = String(req.query.conversationId || '');
    const limit = Number(req.query.limit || 1000);
    if (!uid || !sessionId || !conversationId) return bad(res, 'missing params');

    const rows = await repo.listMessages({ uid, sessionId, conversationId, limit });
    return ok(res, { data: rows });
  } catch (e) {
    return err(res, 'message_list_failed', e);
  }
});

// Create
// POST /api/messages
// body: {
//   sessionId, conversationId, conversationTitle?(optional),
//   message: {
//     role: 'user'|'assistant',
//     text: string,
//     analysisSnapshot_v1?(user만), hf_raw?(user만)
//   }
// }
router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { sessionId, conversationId, conversationTitle, message } = req.body || {};
    if (!uid || !sessionId || !conversationId || !message || !message.text) {
      return bad(res, 'missing required fields');
    }
    const out = await repo.addMessage({ uid, sessionId, conversationId, conversationTitle, message });
    return ok(res, out);
  } catch (e) {
    return err(res, 'message_create_failed', e);
  }
});

// ────────────────────────────────────────────────
// Stats (정확도 분석용)
// ────────────────────────────────────────────────

// Read
// GET /api/conversations/:dateKey/:convId/stats
router.get('/conversations/:dateKey/:convId/stats', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { dateKey, convId } = req.params;
    if (!uid || !dateKey || !convId) return bad(res, 'missing params');

    const data = await repo.getStats({ uid, sessionId: dateKey, conversationId: convId });
    return ok(res, data);
  } catch (e) {
    return err(res, 'stats_read_failed', e);
  }
});

// Update (append / replace)
// PATCH /api/conversations/:dateKey/:convId/stats
// body: { append?: boolean, messageId?: string, confidences?: { llm:..., hf:... }, agreement?: {...} }
router.patch('/conversations/:dateKey/:convId/stats', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { dateKey, convId } = req.params;
    const scores = req.body || {};
    if (!uid || !dateKey || !convId) return bad(res, 'missing params');

    const out = await repo.updateStats({ uid, sessionId: dateKey, conversationId: convId, scores });
    return ok(res, out);
  } catch (e) {
    return err(res, 'stats_update_failed', e);
  }
});

// ────────────────────────────────────────────────
// Calendar
// ────────────────────────────────────────────────

// GET /api/calendar?startDateKey=YYYY-MM-DD&endDateKey=YYYY-MM-DD
// or GET /api/calendar/:dateKey
router.get('/calendar', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { startDateKey, endDateKey } = req.query;
    if (!uid) return bad(res, 'not_authenticated');

    const data = await repo.getCalendar({
      uid,
      startDateKey: startDateKey || undefined,
      endDateKey: endDateKey || undefined
    });
    return ok(res, { data });
  } catch (e) {
    return err(res, 'calendar_range_failed', e);
  }
});

router.get('/calendar/:dateKey', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { dateKey } = req.params;
    if (!uid || !dateKey) return bad(res, 'missing params');

    const data = await repo.getCalendar({ uid, startDateKey: dateKey });
    return ok(res, { data });
  } catch (e) {
    return err(res, 'calendar_read_failed', e);
  }
});

module.exports = router;
