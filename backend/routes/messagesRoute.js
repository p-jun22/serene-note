// backend/routes/messagesRoute.js
const { Router } = require('express');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { authMiddleware } = require('../middlewares/authMiddleware'); // ✅ 경로 수정
const gptService = require('../services/gptService');               // ✅ services/로 경로 통일
const axios = require('axios');

const HF_SERVER_URL = process.env.HF_SERVER_URL || 'http://localhost:8000'; // huggingface_server.py 포트

const router = Router();
router.use(authMiddleware);

// 유틸
const ymd = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
};

// 이모지 매핑 (프론트와 동일 기준)
const EMOJI_MAP = {
  '행복':'😊','기쁨':'😊','즐거움':'😊','만족':'🙂',
  '사랑':'🥰','설렘':'🤩','기대':'🤩',
  '평온':'😌','안정':'😌','중립':'😐',
  '불안':'😟','걱정':'😟','초조':'😟','두려움':'😨','공포':'😨',
  '슬픔':'😢','우울':'😞','상실':'😢',
  '분노':'😠','짜증':'😠','화':'😠',
  '수치심':'😳','부끄러움':'😳',
  '피곤':'🥱','지침':'🥱'
};
const pickEmoji = (labels = []) => {
  for (const raw of labels) {
    const k = String(raw || '').trim();
    if (EMOJI_MAP[k]) return EMOJI_MAP[k];
  }
  return '😐';
};

// HF + GPT 혼합 분석
async function mixAnalyze({ uid, text }) {
  // 1) HuggingFace 서버 호출 (실패해도 무시하고 진행)
  let hf = {};
  try {
    const r = await axios.post(`${HF_SERVER_URL}/analyze`, { text }, { timeout: 20000 });
    hf = r.data || {};
  } catch {}

  // 2) GPT 서비스 호출 (기존 gptService 함수들 중 가용한 것 사용)
  let gpt = {};
  try {
    if (typeof gptService.analyzeText === 'function') {
      gpt = await gptService.analyzeText({ uid, text });
    } else if (typeof gptService.runCBTAnalysis === 'function') {
      gpt = await gptService.runCBTAnalysis(text, { uid });
    } else if (typeof gptService.askGpt === 'function') {
      gpt = await gptService.askGpt({ uid, text });
    } else if (typeof gptService.handle === 'function') {
      gpt = await gptService.handle({ uid, text });
    }
  } catch {}

  // 3) 단순 가중 평균
  const wHF  = Number(process.env.MIX_W_HF  || 0.5);
  const wGPT = Number(process.env.MIX_W_GPT || 0.5);
  const norm = (v) => (v == null ? null : Math.max(0, Math.min(1, Number(v))));
  const schemaScore      = (norm(hf?.schemaScore)      ?? 0) * wHF  + (norm(gpt?.schemaScore)      ?? 0) * wGPT;
  const consistencyScore = (norm(hf?.consistencyScore) ?? 0) * wHF  + (norm(gpt?.consistencyScore) ?? 0) * wGPT;
  const totalScore       = (norm(hf?.totalScore)       ?? 0) * wHF  + (norm(gpt?.totalScore)       ?? 0) * wGPT;

  // 라벨 합치기
  const toArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
  const uniq = (arr) => [...new Set(arr.filter(Boolean).map(String))];
  const emotions    = uniq([...(toArr(hf?.emotions)), ...(toArr(gpt?.감정 || gpt?.emotions))]);
  const distortions = uniq([...(toArr(hf?.distortions)), ...(toArr(gpt?.인지왜곡 || gpt?.cognitiveDistortions))]);
  const coreBelief  = (gpt?.핵심믿음 || gpt?.coreBelief || hf?.coreBelief || '') + '';
  const socraticQuestion = (gpt?.추천질문 || gpt?.socraticQuestion || hf?.socraticQuestion || '') + '';

  return {
    emotions,
    distortions,
    coreBelief,
    socraticQuestion,
    schemaScore,
    consistencyScore,
    totalScore,
  };
}

/**
 * POST /api/messages/send
 * 호환 입력 2가지 모두 허용:
 *  A) { sessionId, conversationId?, text }
 *  B) { sessionId, conversationId?, message: { text, analysisSnapshot_v1? } }
 */
router.post('/send', async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const sessionId = req.body?.sessionId;
    const conversationId = req.body?.conversationId || null;

    // 본문 통합: text 우선, 없으면 message.text
    const text = typeof req.body?.text === 'string'
      ? req.body.text
      : (req.body?.message && typeof req.body.message.text === 'string'
          ? req.body.message.text
          : '');

    if (!text) {
      return res.status(400).json({ error: 'text is required (or message.text)' });
    }

    const dateKey = ymd(sessionId || new Date());
    const db = getFirestore();

    // 1) 대화 문서 준비(프론트가 미리 생성했어도 merge)
    let convId = conversationId;
    if (!convId) {
      const docRef = await db.collection('conversations').add({
        uid, ownerEmail: req.user.email || null, dateKey,
        title: `${dateKey} 대화`,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      convId = docRef.id;
    } else {
      await db.doc(`conversations/${convId}`).set({
        uid, ownerEmail: req.user.email || null, dateKey,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    // 2) 사용자 메시지 저장 (루트/세션 트리 동시 저장)
    const userMsgDoc = {
      role: 'user',
      text,
      createdAt: FieldValue.serverTimestamp(),
      // 과거 형식 호환: 클라가 보낸 analysisSnapshot_v1가 있으면 그대로 보존
      analysisSnapshot_v1: req.body?.message?.analysisSnapshot_v1 || null
    };
    await db.collection(`conversations/${convId}/messages`).add(userMsgDoc);
    await db.collection(`users/${uid}/sessions/${dateKey}/conversations/${convId}/messages`).add(userMsgDoc);

    // 3) 혼합분석
    const mixed = await mixAnalyze({ uid, text });

    // 4) 봇 메시지 생성/저장
    const botText = `
[${dateKey}]
감정: ${mixed.emotions.join(', ')}
인지 왜곡: ${mixed.distortions.join(', ')}
핵심 믿음: ${mixed.coreBelief || '-'}
추천 질문: ${mixed.socraticQuestion || '-'}
(GPT 신뢰도 지표)
- 스키마 일치도: ${mixed.schemaScore?.toFixed?.(2) ?? '-'}
- 일관성 점수: ${mixed.consistencyScore?.toFixed?.(2) ?? '-'}
- 통합 신뢰도: ${mixed.totalScore?.toFixed?.(2) ?? '-'}
`.trim();

    const botMsgDoc = {
      role: 'assistant',
      text: botText,
      createdAt: FieldValue.serverTimestamp(),
      analysisSnapshot_v1: {
        emotions: mixed.emotions,
        distortions: mixed.distortions,
        coreBeliefs: mixed.coreBelief ? [mixed.coreBelief] : [],
        recommendedQuestions: mixed.socraticQuestion ? [mixed.socraticQuestion] : [],
        confidences: {
          schemaScore: mixed.schemaScore ?? null,
          consistencyScore: mixed.consistencyScore ?? null,
          totalScore: mixed.totalScore ?? null,
        }
      }
    };

    await db.collection(`conversations/${convId}/messages`).add(botMsgDoc);
    await db.collection(`users/${uid}/sessions/${dateKey}/conversations/${convId}/messages`).add(botMsgDoc);

    // 5) 캘린더 집계/대표 이모지 업데이트
    const moodEmoji = pickEmoji(mixed.emotions);
    const calRef = db.doc(`users/${uid}/calendar/${dateKey}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(calRef);
      const prev = snap.exists ? snap.data() : {};
      const nextCount = (typeof prev.count === 'number' ? prev.count : 0) + 1;
      tx.set(calRef, {
        count: nextCount,
        topEmoji: moodEmoji,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    // 6) 대화 메타 업데이트
    await db.doc(`conversations/${convId}`).set({
      updatedAt: FieldValue.serverTimestamp(),
      lastBotAt: FieldValue.serverTimestamp(),
      moodEmoji,
      moodLabels: mixed.emotions,
    }, { merge: true });

    return res.json({
      conversationId: convId,
      user: { text },
      bot: { text: botText },
      moodEmoji,
      moodLabels: mixed.emotions,
      calendar: { topEmoji: moodEmoji },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
