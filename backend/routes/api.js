// backend/routes/api.js
// ─────────────────────────────────────────────────────────────
// [역할 요약]
// - 모든 /api/* 엔드포인트 총괄 (입력 검증 → 서비스/레포 호출)
// - Firestore 직접 접근 금지(레포 사용). 단, 서버타임 상수는 라우터에서 patch에 주입 가능.
// - Tree.txt 및 자가 경계 프롬프트 준수.
//
// [핵심 변경 요약(A/B)]
// A) Seed 완전 제거: POST /conversations 가 "(대화 생성)" 메시지 만들지 않음(대화 문서만 생성)
// B) 분석 파이프라인: /gpt/analyze 에 멱등성 + Stage-2(두 번째 user부터) 적용
//    - clientMessageId 중복이면 기존 스냅샷 그대로 반환(재저장/재집계 없음)
//    - countUserMessages >= 1 이면 enableStage2=true 로 gptService 호출
//
// [기타]
// - assistant 메시지에는 analysisSnapshot_v1/hf_raw 저장 금지(정책 강제)
// - assistant 저장도 correlationId 기반 멱등 처리
// - 캘린더 범위/단일 조회는 repo.getCalendar()만 사용(루트 레거시 경로 폐기)
// ─────────────────────────────────────────────────────────────

const express = require('express');
const axios = require('axios');
const router = express.Router();

const { authMiddleware } = require('../middlewares/authMiddleware');
const { admin } = require('../firebaseAdmin'); // 서버타임 스탬프 주입용
const repo = require('../services/firestoreRepository');
const gpt = require('../services/gptService');

const HF_BASE = process.env.HF_BASE_URL || process.env.HF_SERVER || 'http://127.0.0.1:5001';

/* 공통 헬퍼 */
function fail(res, code, error, detail) {
  if (detail) console.error('[api]', error, detail);
  return res.status(code).json({ ok: false, error });
}
const ymd = (s) => String(s || '').slice(0, 10);

/* 라우터 접근 로깅(디버그) */
router.use((req, _res, next) => {
  console.log('[api]', req.method, req.originalUrl);
  next();
});

/* ─────────────────────────────────────────────
   1) Messages (assistant 전용 저장 + 목록/수정)
───────────────────────────────────────────── */

/**
 * POST /api/messages
 * - assistant 메시지만 저장 허용(분석 스냅샷/로짓 금지)
 * - correlationId(= 대응 user의 clientMessageId)로 멱등 보장
 * body: { sessionId, conversationId, message:{ role:'assistant', text, correlationId? } }
 */
router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { sessionId, conversationId, message } = req.body || {};
    const role = String(message?.role || 'assistant');
    const text = String(message?.text || '').trim();
    const correlationId = message?.correlationId ? String(message.correlationId) : null;

    if (!uid || !sessionId || !conversationId || !text) {
      return fail(res, 400, 'bad_params');
    }
    if (role !== 'assistant') {
      // user 메시지는 /gpt/analyze 로만 저장 (정책)
      return fail(res, 400, 'use_gpt_analyze_for_user');
    }
    if (message.analysisSnapshot_v1 || message.hf_raw) {
      return fail(res, 400, 'assistant_snapshot_forbidden');
    }

    // 멱등: 동일 correlationId 가 이미 저장되어 있으면 skip
    if (correlationId) {
      const dup = await repo.findAssistantByCorrelation({
        uid, sessionId: ymd(sessionId), conversationId, correlationId
      });
      if (dup) return res.json({ ok: true, dedup: true });
    }

    await repo.addMessage({
      uid,
      sessionId: ymd(sessionId),
      conversationId,
      message: { role: 'assistant', text, lastBot: true, correlationId }
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, 'messages_create_failed', err);
  }
});

/**
 * GET /api/conversations/:conversationId/messages?sessionId=YYYY-MM-DD&limit=1000
 * - 특정 대화의 메시지 목록
 */
router.get('/conversations/:conversationId/messages', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const conversationId = String(req.params.conversationId || '');
    const sessionId = ymd(req.query.sessionId || '');
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
 * - 사용자 메시지 텍스트 편집(간단 교체). 스냅샷 재분석은 별도 정책.
 * body: { sessionId, conversationId, text }
 */
router.patch('/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const messageId = String(req.params.messageId || '');
    const { sessionId, conversationId, text } = req.body || {};

    if (!uid || !sessionId || !conversationId || !messageId || typeof text !== 'string') {
      return res.status(400).json({ ok:false, error:'bad_params' });
    }

    await repo.updateMessageText(
      uid,
      ymd(sessionId),
      String(conversationId),
      messageId,
      String(text || '')
    );

    return res.json({ ok:true });
  } catch (e) {
    const code = e.code || 'server_error';
    const http = (code === 'not_found') ? 404 : (code === 'forbidden' ? 403 : 500);
    return res.status(http).json({ ok:false, error:code, message:e.message });
  }
});

/* ─────────────────────────────────────────────
   2) Conversations (목록/생성/수정/삭제)
───────────────────────────────────────────── */

/**
 * GET /api/conversations?sessionId=YYYY-MM-DD&limit=500
 * - 세션별 대화 목록
 */
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const sessionId = ymd(req.query.sessionId || '');
    const limit = Number(req.query.limit || 500);
    if (!uid || !sessionId) return fail(res, 400, 'bad_params');

    const list = await repo.listConversations({ uid, sessionId, limit });
    return res.json({ ok: true, data: list });
  } catch (err) {
    return fail(res, 500, 'conversations_list_failed', err);
  }
});

/**
 * POST /api/conversations
 * - ★ Seed 금지: 대화 문서만 생성(메시지 생성하지 않음)
 * body: { sessionId, conversationId?, title? }
 */
router.post('/conversations', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { sessionId, conversationId, title } = req.body || {};
    if (!uid || !sessionId) return fail(res, 400, 'bad_params');

    const cid = conversationId || (require('crypto').randomUUID ?
      require('crypto').randomUUID() :
      Math.random().toString(36).slice(2) + Date.now().toString(36));

    // 레포 함수(create)가 없다면 메타 set으로 문서만 보장(merge)
    // createdAt은 서버시간으로 주입
    await repo.updateConversationMeta({
      uid,
      dateKey: ymd(sessionId),
      conversationId: cid,
      patch: {
        id: cid,
        uid,
        dateKey: ymd(sessionId),
        title: String(title || `${ymd(sessionId)} 대화`),
        moodEmoji: null,
        moodLabels: [],
        distortions: [],
        coreBeliefs: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    });

    // 집계 갱신
    await repo.recomputeCalendar({ uid, sessionId: ymd(sessionId) });

    const items = await repo.listConversations({ uid, sessionId: ymd(sessionId), limit: 500 });
    return res.json({ ok: true, id: cid, data: items });
  } catch (e) {
    return fail(res, 500, 'conversation_create_failed', e);
  }
});

/**
 * PUT /api/conversations/:conversationId
 * - 제목 변경(레포에서 집계까지 처리)
 */
router.put('/conversations/:conversationId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const conversationId = String(req.params.conversationId);
    const { sessionId, title } = req.body || {};
    if (!uid || !sessionId || !conversationId || !title) return fail(res, 400, 'bad_params');

    await repo.updateConversationTitle({
      uid,
      sessionId: ymd(sessionId),
      conversationId,
      title: String(title).trim()
    });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, 'conversation_update_failed', err);
  }
});

/**
 * PATCH /api/conversations/:conversationId?sessionId=YYYY-MM-DD
 * - 메타/노트 등 소규모 패치
 */
router.patch('/conversations/:conversationId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { conversationId } = req.params;
    const sessionId = ymd(req.query.sessionId || req.body?.sessionId || '');
    const { title, note } = req.body || {};
    if (!uid || !conversationId || !sessionId) return fail(res, 400, 'bad_params');

    if (typeof title === 'string' && title.trim()) {
      await repo.updateConversationTitle({ uid, sessionId, conversationId, title: title.trim() });
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

/**
 * DELETE /api/conversations/:conversationId?sessionId=YYYY-MM-DD
 * - 대화+하위 메시지 일괄 삭제 + 집계 재계산
 */
router.delete('/conversations/:conversationId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const conversationId = String(req.params.conversationId);
    const sessionId = ymd(req.query.sessionId || req.body?.sessionId || '');
    if (!uid || !sessionId || !conversationId) return fail(res, 400, 'bad_params');

    await repo.deleteConversationCascade({ uid, sessionId, conversationId });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, 'conversation_delete_failed', err);
  }
});

/* ─────────────────────────────────────────────
   3) Calendar (범위/단일)
───────────────────────────────────────────── */

/**
 * GET /api/calendar?startDateKey=YYYY-MM-DD&endDateKey=YYYY-MM-DD
 * - sessions/{dateKey}/calendar/summary 만 조회
 */
router.get('/calendar', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const startDateKey = req.query.startDateKey ? ymd(req.query.startDateKey) : undefined;
    const endDateKey   = req.query.endDateKey ? ymd(req.query.endDateKey)   : undefined;
    if (!uid) return fail(res, 400, 'bad_params');

    const data = await repo.getCalendar({ uid, startDateKey, endDateKey });
    return res.json({ ok: true, data });
  } catch (err) {
    return fail(res, 500, 'calendar_failed', err);
  }
});

/**
 * GET /api/calendar/:dateKey
 * - 단일 날짜 summary 1건 반환
 */
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

/* ─────────────────────────────────────────────
   4) Models / Analysis
───────────────────────────────────────────── */

/**
 * POST /api/gpt/analyze
 * - user 메시지 저장 + 분석 스냅샷 생성/반환
 * - 멱등성(clientMessageId) + Stage-2(두 번째 user부터) 적용
 * body: { sessionId, conversationId, text, clientMessageId? }
 */
router.post('/gpt/analyze', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid || null;
    const sessionId = ymd(req.body?.sessionId || req.body?.dateKey || '');
    const conversationId = String(req.body?.conversationId || '').trim();
    const clientMessageId = req.body?.clientMessageId ? String(req.body.clientMessageId) : null;
    const textRaw = (req.body?.text ?? req.body?.input ?? '');
    const text = String(textRaw).replace(/\s+/g, ' ').trim();

    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!sessionId || !conversationId || !text) return fail(res, 400, 'bad_params');

    // 1) 멱등성: 이미 같은 clientMessageId 로 저장된 user 메시지가 있으면 그대로 반환
    if (clientMessageId) {
      const dup = await repo.findUserMessageByClientKey({ uid, sessionId, conversationId, clientMessageId });
      if (dup && dup.analysisSnapshot_v1) {
        return res.json({ ok: true, messageId: dup.id, analysisSnapshot_v1: dup.analysisSnapshot_v1, hf_raw: dup.hf_raw ?? null, dedup: true });
      }
    }

    // 2) Stage-2 트리거: 해당 대화 user 메시지 개수가 1개 이상이면 이번 입력은 2번째 이상
    const userCount = await repo.countUserMessages({ uid, sessionId, conversationId });
    const enableStage2 = userCount >= 1;

    // 3) LLM/HF 분석 실행
    const { snapshot, hf_raw } = await gpt.analyzeMessage({
      uid,
      dateKey: sessionId,
      conversationId,
      userText: text,
      enableStage2,
    });

    // 4) user 메시지 1회 저장(+ 스냅샷/로짓) — 멱등성 키 연결
    await repo.addMessage({
      uid,
      sessionId,
      conversationId,
      message: {
        role: 'user',
        text,
        analysisSnapshot_v1: snapshot,
        hf_raw: hf_raw ?? null,
        clientMessageId: clientMessageId || null,
      }
    });

    // 5) 결과 반환
    return res.json({ ok: true, analysisSnapshot_v1: snapshot, hf_raw: hf_raw ?? null });
  } catch (e) {
    console.error('[api] /gpt/analyze failed:', e);
    return res.status(500).json({ ok: false, error: 'gpt_analyze_failed', message: e?.message || 'internal_error' });
  }
});

/**
 * GET /api/models/session-analysis/:dateKey
 * - 세션 상세 분석(집계)
 */
router.get('/models/session-analysis/:dateKey', authMiddleware, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const dateKey = ymd(req.params?.dateKey);
    if (!uid || !dateKey) return fail(res, 400, 'bad_params');

    const data = await repo.getSessionDetailedAnalysis({ uid, dateKey });
    return res.json({ ok: true, data });
  } catch (err) {
    return fail(res, 500, 'session_analysis_failed', err);
  }
});

/**
 * HF 보조 서버 헬스/강점 분석(유지)
 */
router.get('/models/strength/health', authMiddleware, async (_req, res) => {
  try {
    const r = await axios.get(`${HF_BASE}/health`, { timeout: 5000 });
    return res.json({ ok: true, hf: r.data?.ok === true });
  } catch (_e) {
    return res.json({ ok: true, hf: false });
  }
});

router.post('/models/strength/analyze', authMiddleware, async (req, res) => {
  try {
    const { input } = req.body || {};
    if (!input || typeof input !== 'string') return fail(res, 400, 'bad_params');
    const r = await axios.post(`${HF_BASE}/analyze-strength`, { input }, { timeout: 30000 });
    return res.json(r.data);
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({ error: 'flask_call_failed', detail: err?.response?.data || null });
  }
});

module.exports = router;
