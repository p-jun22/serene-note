// backend/services/firestoreRepository.js
// ─────────────────────────────────────────────────────────────
// 1) Firestore I/O 단일 창구 (대화/메시지 CRUD)
// 2) 캘린더 집계(recomputeCalendar)
// 3) 분석/그래프용 조회 유틸 (세션/월 범위 조회 등)
// 4) Stage-2/dup 준비 유틸(countUserMessages 등)

// ─────────────────────────────────────────────────────────────
// - 경로 스키마(불변):
//   users/{uid}/sessions/{dateKey}/conversations/{cid}/messages/{mid}
//   users/{uid}/sessions/{dateKey}/calendar/summary
// - 서버 시간은 FieldValue.serverTimestamp()만 사용 (클라 시간 금지)
// - 집계 필요 변경 시 recomputeCalendar(uid, dateKey) 반드시 호출
// ─────────────────────────────────────────────────────────────

const { admin, db } = require('../firebaseAdmin');
const { FieldValue, FieldPath } = admin.firestore;

/* ─────────────────────────────────────────────
   0) 날짜 유틸(YYYY-MM-DD 고정)
───────────────────────────────────────────── */
function ymd(x) {
  if (!x) return null;
  return String(x).slice(0, 10);
}
function toUTCDate(k /* YYYY-MM-DD */) {
  const [y, m, d] = k.split('-').map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}
function plus1day(k) {
  const dt = toUTCDate(k);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/* ─────────────────────────────────────────────
   1) 경로 헬퍼 (Tree.txt)
───────────────────────────────────────────── */
function userDoc(uid) { return db.collection('users').doc(String(uid)); }
function sessionDoc(uid, dateKey) { return userDoc(uid).collection('sessions').doc(String(dateKey)); }
function conversationsCol(uid, dateKey) { return sessionDoc(uid, dateKey).collection('conversations'); }
function conversationDoc(uid, dateKey, cid) { return conversationsCol(uid, dateKey).doc(String(cid)); }
function messagesCol(uid, dateKey, cid) { return conversationDoc(uid, dateKey, cid).collection('messages'); }

// 캘린더 요약(SOT): 세션 하위 summary 하나만 사용
function calendarSummaryDoc(uid, dateKey) { return sessionDoc(uid, dateKey).collection('calendar').doc('summary'); }

/* ─────────────────────────────────────────────
   2) 공용 유틸
───────────────────────────────────────────── */
function nowTS() { return FieldValue.serverTimestamp(); }
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
function pushCount(map, k, n = 1) { if (!k) return; map[k] = (map[k] || 0) + n; }
function isNonEmptyArray(a) { return Array.isArray(a) && a.length > 0; }

// ── 이모지 매핑 (라벨 확장)
const EMOJI = {
  행복: '😊', 기쁨: '😊', 즐거움: '😊', 만족: '🙂',
  사랑: '🥰', 설렘: '🤩', 기대: '🤩', 신뢰: '🙂',
  평온: '😌', 안정: '😌', 중립: '😐', 안도: '😌',
  놀람: '😮', 당혹: '😳',
  불안: '😟', 걱정: '😟', 초조: '😟', 긴장: '😬',
  두려움: '😨', 공포: '😨',
  슬픔: '😢', 우울: '😞', 상실: '😢', 외로움: '😞', 무기력: '😔',
  분노: '😠', 짜증: '😠', 화: '😠', 혐오: '🤢',
  수치심: '😳', 부끄러움: '😳',
  피곤: '🥱', 지침: '🥱'
};

function pickEmojiFromLabels(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null; // ← 바뀐 부분
  for (const l of arr) {
    const k = String(l || '').trim();
    if (EMOJI[k]) return EMOJI[k];
  }
  return null;
}

/* ─────────────────────────────────────────────
   3) 스냅샷 파서(호환 강화)
───────────────────────────────────────────── */
function extractSnapshotVectors(snap = {}, hf_raw = {}) {
  const out = snap?.llm?.output || {};

  const emotions =
    Array.isArray(snap.emotions) ? snap.emotions.filter(Boolean)
      : Array.isArray(out['감정']) ? out['감정'].filter(Boolean)
        : [];

  const distortions =
    Array.isArray(snap.distortions) ? snap.distortions.filter(Boolean)
      : Array.isArray(out['인지왜곡']) ? out['인지왜곡'].filter(Boolean)
        : [];

  const coreBeliefs =
    Array.isArray(snap.coreBeliefs) ? snap.coreBeliefs.filter(Boolean)
      : (out['핵심믿음'] ? [out['핵심믿음']] : []).filter(Boolean);

  const questions =
    Array.isArray(snap.recommendedQuestions) ? snap.recommendedQuestions.filter(Boolean)
      : (out['추천질문'] ? [out['추천질문']] : []).filter(Boolean);

  const c = snap?.confidences || snap?.llm?.confidences || {};
  const llm = {
    emotions: num(c.emotions),
    distortions: num(c.distortions),
    coreBelief: num(c.coreBelief),
    question: num(c.question),
  };

  const hf = {
    emotions_avg: num(snap?.hf?.emotion?.avg ?? hf_raw?.emotions_avg ?? hf_raw?.emotion?.avg),
    emotion_entropy: num(snap?.hf?.emotion?.entropy ?? hf_raw?.emotion_entropy ?? hf_raw?.emotion?.entropy),
    core_entail: num(snap?.hf?.nli?.core?.entail ?? hf_raw?.nli_core?.entail ?? hf_raw?.nli?.core?.entail),
    core_contradict: num(snap?.hf?.nli?.core?.contradict ?? hf_raw?.nli_core?.contradict ?? hf_raw?.nli?.core?.contradict),
  };

  return { emotions, distortions, coreBeliefs, questions, llm, hf };
}

/* ─────────────────────────────────────────────
   4) 캘린더 집계 - “빈날 삭제(미생성) 정책
   - 저장 위치: users/{uid}/sessions/{dateKey}/calendar/summary 단일
   - count는 user 메시지가 1개 이상 존재하는 대화 수
   - 대화 메타에 감정 라벨이 없으면 최신 user 메시지에서 보강
   - count === 0이면 summary 문서 삭제 후 null 반환(프론트에 표시 안 함)
   - 대화 문서 메타만 사용(O(N))
───────────────────────────────────────────── */
async function recomputeCalendar({ uid, sessionId }) {
  if (!uid || !sessionId) throw new Error('bad_params');

  const convSnap = await conversationsCol(uid, sessionId).get();

  const convSet = {};
  const moodCounters = {};
  let lastEmoji = null;
  let lastTs = 0;

  convSnap.forEach((doc) => {
    const v = doc.data() || {};

    // user 메시지가 하나라도 있으면 count 포함
   const hasAny = (v.userMsgCount > 0) || !!v.lastUserAt;
    if (!hasAny) return;

    convSet[doc.id] = true;

    // 이모지는 user 기반 라벨이 있을 때만
    const labels = Array.isArray(v.moodLabels) ? v.moodLabels.filter(Boolean) : [];
    const ts = v.lastUserAt?.toMillis?.() || v.lastMsgAt?.toMillis?.()
            || v.updatedAt?.toMillis?.() || v.createdAt?.toMillis?.() || 0;

    labels.forEach((lb) => pushCount(moodCounters, lb));
    if (labels.length && ts >= lastTs) {
      lastTs = ts;
      lastEmoji = pickEmojiFromLabels(labels);
    }
  });

  const count = Object.keys(convSet).length;

  // 완전 빈 날이면 summary 삭제 후 종료
  if (count === 0) {
    await calendarSummaryDoc(uid, sessionId).delete().catch(() => {});
    return null;
  }

  // 최빈 라벨 => topEmoji
  let topEmoji = null, max = -1, topLabel = null;
  for (const [label, c] of Object.entries(moodCounters)) {
    if (c > max) { max = c; topLabel = label; }
  }
  if (topLabel) topEmoji = pickEmojiFromLabels([topLabel]);

  const payload = {
    uid,
    dateKey: sessionId,
    convSet,
    count,
    moodCounters,
    lastEmoji: lastEmoji || null,
    topEmoji: topEmoji || lastEmoji || null,
    updatedAt: nowTS(),
  };

  await calendarSummaryDoc(uid, sessionId).set(payload, { merge: true });
  return payload;
}


/* ─────────────────────────────────────────────
   5) 캘린더 범위 조회 - 하이브리드 자기치유(빈날 스킵)
   - group 쿼리로 긁고, 누락 날짜는 on-demand 재집계
   - 재집계 결과 count===0이면 out에 넣지 않음(표시 안 함)
───────────────────────────────────────────── */
async function getCalendar({ uid, startDateKey, endDateKey, heal = false }) {
  if (!uid) throw new Error('bad_params');

  const start = startDateKey ? ymd(startDateKey) : null;
  const end   = endDateKey   ? ymd(endDateKey)   : start;
  if (!start || !end) throw new Error('bad_params');

  const out = {};

  // 1) group 쿼리로 존재하는 요약을 한 번에 긁어오기
  const snap = await db.collectionGroup('calendar')
    .where('uid','==',uid)
    .where('dateKey','>=',start)
    .where('dateKey','<=',end)
    .get();

  snap.forEach((doc) => {
    const v = doc.data() || {};
    const k = v.dateKey || '0000-00-00';
    if ((v.count ?? 0) > 0) {
      out[k] = {
        dateKey: k,
        emoji: v.topEmoji || v.lastEmoji || null,
        convSet: v.convSet || {},
        count: v.count,
        moodLabels: Array.isArray(v.moodLabels) ? v.moodLabels : [],
        touchedAt: v.updatedAt || null,
      };
    }
  });

  // 2) heal 모드: 누락 날짜만 on-demand 재집계
  if (heal) {
    for (let k = start; ; k = plus1day(k)) {
      if (!out[k]) {
        const agg = await recomputeCalendar({ uid, sessionId: k });
        if (agg && agg.count > 0) {
          out[k] = {
            dateKey: k,
            emoji: agg.topEmoji || agg.lastEmoji || null,
            convSet: agg.convSet || {},
            count: agg.count || 0,
            moodLabels: [],
            touchedAt: agg.updatedAt || null,
          };
        }
      }
      if (k === end) break;
    }
  }

  return out;
}


/* ─────────────────────────────────────────────
   6) 메시지/대화 CRUD
───────────────────────────────────────────── */
async function addMessage({ uid, sessionId, conversationId, conversationTitle, message }) {
  if (!uid || !sessionId || !conversationId || !message || !message.text) {
    throw new Error('missing required fields');
  }

  const convRef = conversationDoc(uid, sessionId, conversationId);
  const sessRef = sessionDoc(uid, sessionId);
  const now = nowTS();

  const snap = message.analysisSnapshot_v1 || null;   // user만 사용
  const hf_raw = message.hf_raw ?? null;

  const vec = snap ? extractSnapshotVectors(snap, hf_raw) : { emotions: [], distortions: [], coreBeliefs: [] };

  await db.runTransaction(async (tx) => {
    const convSnap = await tx.get(convRef);

    if (!convSnap.exists) {
      tx.set(convRef, {
        id: conversationId,
        uid,
        dateKey: sessionId,
        title: conversationTitle || `${sessionId} 대화`,
        moodEmoji: null,
        moodLabels: [],
        distortions: [],
        coreBeliefs: [],
        createdAt: now,
        updatedAt: now,
        lastBotAt: null,
      }, { merge: true });
    } else {
      tx.update(convRef, { updatedAt: now });
    }

    const msgRef = messagesCol(uid, sessionId, conversationId).doc();
    const role = (message.role || 'user');

    const base = {
      id: msgRef.id,
      uid,
      dateKey: sessionId,
      role,
      text: String(message.text || ''),
      createdAt: now,
    };

    if (role === 'user') {
      base.analysisSnapshot_v1 = snap || null;
      base.hf_raw = hf_raw;
      if (message.clientMessageId) base.clientMessageId = String(message.clientMessageId);
    } else {
      base.analysisSnapshot_v1 = null;
      base.hf_raw = null;
      base.lastBot = true;
      if (message.correlationId) base.correlationId = String(message.correlationId);
    }

    tx.set(msgRef, base);

    // (3) 대화 메타 갱신
    const updates = { updatedAt: now, lastMsgAt: now, msgCount: FieldValue.increment(1) };
    if (role === 'assistant') {
      updates.lastBotAt = now;
    } else if (role === 'user' && snap) {
      const labels = Array.isArray(vec.emotions) ? vec.emotions : [];
      const moodEmoji = pickEmojiFromLabels(labels);
      updates.moodLabels = labels;
      updates.moodEmoji = moodEmoji;
      updates.distortions = Array.isArray(vec.distortions) ? vec.distortions : [];
      updates.coreBeliefs = Array.isArray(vec.coreBeliefs) ? vec.coreBeliefs : [];
      updates.userMsgCount = FieldValue.increment(1);
      updates.lastUserAt = now;
    }
    tx.set(convRef, updates, { merge: true });

    tx.set(sessRef, { dateKey: sessionId, touchedAt: now }, { merge: true });
  });

  await recomputeCalendar({ uid, sessionId });
  return { ok: true };
}

async function listConversations({ uid, sessionId, limit = 100 }) {
  const snap = await conversationsCol(uid, sessionId).orderBy('createdAt', 'asc').limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function listMessages({ uid, sessionId, conversationId, limit = 1000 }) {
  const snap = await messagesCol(uid, sessionId, conversationId).orderBy('createdAt', 'asc').limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function updateConversationTitle({ uid, sessionId, conversationId, title }) {
  await conversationDoc(uid, sessionId, conversationId)
    .set({ title: String(title || '').trim(), updatedAt: nowTS() }, { merge: true });
  await recomputeCalendar({ uid, sessionId });
  return { ok: true };
}

async function updateConversationMeta({ uid, dateKey, conversationId, patch }) {
  const convRef = conversationDoc(uid, dateKey, conversationId);
  await convRef.set({ ...patch, updatedAt: nowTS() }, { merge: true });
  return { ok: true };
}

async function deleteConversationCascade({ uid, sessionId, conversationId }) {
  const convRef = conversationDoc(uid, sessionId, conversationId);

  const msgs = await messagesCol(uid, sessionId, conversationId).get();
  const CHUNK = 400;
  for (let i = 0; i < msgs.docs.length; i += CHUNK) {
    const batch = db.batch();
    msgs.docs.slice(i, i + CHUNK).forEach(m => batch.delete(m.ref));
    await batch.commit();
  }

  await convRef.delete();
  await recomputeCalendar({ uid, sessionId });
  return { ok: true };
}

/**
 * 사용자 메시지 텍스트 수정 (assistant 금지)
 */
async function updateMessageText(uid, sessionId, conversationId, messageId, text) {
  if (!uid || !sessionId || !conversationId || !messageId) {
    const err = new Error('bad_params'); err.code = 'bad_params'; throw err;
  }

  const msgRef = messagesCol(uid, sessionId, conversationId).doc(String(messageId));
  const snap = await msgRef.get();
  if (!snap.exists) {
    const err = new Error('not_found'); err.code = 'not_found'; throw err;
  }

  const data = snap.data() || {};
  if (data.role !== 'user') {
    const err = new Error('only_user_message_editable'); err.code = 'forbidden'; throw err;
  }

  await msgRef.set({
    text: String(text || ''),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await conversationDoc(uid, sessionId, conversationId)
    .set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true };
}

/* ─────────────────────────────────────────────
   7) 분석/통계 보조 유틸
───────────────────────────────────────────── */
function avg(xs) { const a = (xs || []).filter(Number.isFinite); if (!a.length) return null; return a.reduce((p, c) => p + c, 0) / a.length; }
const toFixedOrNull = (n, p = 2) => (Number.isFinite(n) ? +n.toFixed(p) : null);

async function getEmotionsRange({ uid, from, to, maxConversations = 500, maxMessagesPerConv = 400 }) {
  if (!uid || !from || !to) throw new Error('bad_params');

  const sessions = await userDoc(uid).collection('sessions')
    .where(FieldPath.documentId(), '>=', from)
    .where(FieldPath.documentId(), '<=', to)
    .get();

  const out = {};
  for (const s of sessions.docs) {
    const dateKey = s.id;
    const convRefs = await conversationsCol(uid, dateKey).listDocuments();
    const pick = convRefs.slice(0, maxConversations);

    const counts = {};
    const expanded = [];
    for (const c of pick) {
      const msgSnap = await c.collection('messages')
        .where('role', '==', 'user')
        .orderBy('createdAt', 'asc')
        .limit(maxMessagesPerConv)
        .get();
      msgSnap.forEach(m => {
        const d = m.data() || {};
        const v = extractSnapshotVectors(d.analysisSnapshot_v1 || {}, d.hf_raw || {});
        (v.emotions || []).forEach(e => { pushCount(counts, e); expanded.push(e); });
      });
    }
    out[dateKey] = { counts, emotions: expanded };
  }
  return out;
}

async function getSessionDetailedAnalysis({ uid, dateKey, maxConversations = 800, maxMessages = 1200 }) {
  if (!uid || !dateKey) throw new Error('bad_params');

  const convRefs = await conversationsCol(uid, dateKey).listDocuments();
  const use = convRefs.slice(0, maxConversations);

  const counts = { emotions: {}, distortions: {}, coreBeliefs: {}, questions: {} };
  const llm = { emotions: [], distortions: [], coreBelief: [], question: [] };
  const hf = { emotions_avg: [], emotion_entropy: [], core_entail: [], core_contradict: [] };

  let messageTotal = 0;
  for (const c of use) {
    const msgSnap = await c.collection('messages')
      .where('role', '==', 'user')
      .orderBy('createdAt', 'asc')
      .limit(maxMessages)
      .get();
    msgSnap.forEach(doc => {
      const d = doc.data() || {}; messageTotal += 1;
      const v = extractSnapshotVectors(d.analysisSnapshot_v1 || {}, d.hf_raw || {});
      (v.emotions || []).forEach(e => pushCount(counts.emotions, e));
      (v.distortions || []).forEach(e => pushCount(counts.distortions, e));
      (v.coreBeliefs || []).forEach(e => pushCount(counts.coreBeliefs, e));
      (v.questions || []).forEach(e => pushCount(counts.questions, e));

      if (v.llm) {
        if (v.llm.emotions != null) llm.emotions.push(v.llm.emotions);
        if (v.llm.distortions != null) llm.distortions.push(v.llm.distortions);
        if (v.llm.coreBelief != null) llm.coreBelief.push(v.llm.coreBelief);
        if (v.llm.question != null) llm.question.push(v.llm.question);
      }
      if (v.hf) {
        if (v.hf.emotions_avg != null) hf.emotions_avg.push(v.hf.emotions_avg);
        if (v.hf.emotion_entropy != null) hf.emotion_entropy.push(v.hf.emotion_entropy);
        if (v.hf.core_entail != null) hf.core_entail.push(v.hf.core_entail);
        if (v.hf.core_contradict != null) hf.core_contradict.push(v.hf.core_contradict);
      }
    });
  }

  return {
    dateKey,
    totals: { conversations: use.length, messages: messageTotal },
    top: {
      emotions: Object.entries(counts.emotions).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
      distortions: Object.entries(counts.distortions).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
      coreBeliefs: Object.entries(counts.coreBeliefs).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
      questions: Object.entries(counts.questions).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    },
    averages: {
      llm: {
        emotions: toFixedOrNull(avg(llm.emotions)),
        distortions: toFixedOrNull(avg(llm.distortions)),
        coreBelief: toFixedOrNull(avg(llm.coreBelief)),
        question: toFixedOrNull(avg(llm.question)),
      },
      hf: {
        emotions_avg: toFixedOrNull(avg(hf.emotions_avg)),
        emotion_entropy: toFixedOrNull(avg(hf.emotion_entropy)),
        core_entail: toFixedOrNull(avg(hf.core_entail)),
        core_contradict: toFixedOrNull(avg(hf.core_contradict)),
      }
    }
  };
}

/* ─────────────────────────────────────────────
   8) Stage-2/멱등성 준비 유틸
───────────────────────────────────────────── */
async function countUserMessages({ uid, sessionId, conversationId }) {
  const snap = await messagesCol(uid, sessionId, conversationId).where('role', '==', 'user').get();
  return snap.size || 0;
}

async function findUserMessageByClientKey({ uid, sessionId, conversationId, clientMessageId }) {
  if (!clientMessageId) return null;
  const snap = await messagesCol(uid, sessionId, conversationId)
    .where('role', '==', 'user')
    .where('clientMessageId', '==', String(clientMessageId))
    .limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function findAssistantByCorrelation({ uid, sessionId, conversationId, correlationId }) {
  if (!correlationId) return null;
  const snap = await messagesCol(uid, sessionId, conversationId)
    .where('role', '==', 'assistant')
    .where('correlationId', '==', String(correlationId))
    .limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

/* ─────────────────────────────────────────────
   9) 개인 캘리브레이션 / 피드백 SOT
───────────────────────────────────────────── */
async function getCalibrationProfile(uid) {
  if (!uid) throw new Error('bad_params');
  const ref = db.collection('users').doc(String(uid))
    .collection('profile').doc('calibration');
  const snap = await ref.get();
  return snap.exists ? { id: ref.id, ...snap.data() } : null;
}

async function setCalibrationProfile(uid, profile) {
  if (!uid || !profile || typeof profile !== 'object') throw new Error('bad_params');
  const ref = db.collection('users').doc(String(uid))
    .collection('profile').doc('calibration');
  await ref.set({
    ...profile,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
}

async function upsertFeedback(uid, messageId, payload) {
  if (!uid || !messageId) throw new Error('bad_params');
  const ref = db.collection('users').doc(String(uid))
    .collection('feedback').doc(String(messageId));
  const snap = await ref.get();
  const existed = snap.exists;
  await ref.set({ ...payload }, { merge: true });
  return { ok: true, upserted: true, existed };
}

async function countFeedbackSamples(uid) {
  if (!uid) throw new Error('bad_params');
  const col = db.collection('users').doc(String(uid)).collection('feedback');
  const snap = await col.get();
  return { count: snap.size || 0 };
}

/* ─────────────────────────────────────────────
   10) 구버전 호환: 메시지 각각 평점
───────────────────────────────────────────── */
async function setUserRating({ uid, sessionId, conversationId, messageId, rating }) {
  if (!uid || !sessionId || !conversationId || !messageId) throw new Error('bad_params');
  const ref = messagesCol(uid, sessionId, conversationId).doc(String(messageId));
  await ref.set({ userRating: Number(rating) }, { merge: true });
  return { ok: true };
}

// ─────────────────────────────────────────────
// 최근(user) 메시지의 analysisSnapshot_v1 조회
// ─────────────────────────────────────────────
async function getLastUserSnapshot({ uid, sessionId, conversationId }) {
  const col = db.collection(
    `users/${uid}/sessions/${sessionId}/conversations/${conversationId}/messages`
  );

  // createdAt 내림차순으로 몇 개만 스캔해서 가장 최근 user 스냅샷 1개 찾기
  const snap = await col.orderBy('createdAt', 'desc').limit(20).get();
  let prev = null;
  snap.forEach((doc) => {
    const v = doc.data() || {};
    if (!prev && (v.role === 'user' || v.sender === 'user') && v.analysisSnapshot_v1) {
      prev = v.analysisSnapshot_v1;
    }
  });
  return prev;
}


// users/{uid}/feedbackCompare/{pairId} : 승자만 저장
async function saveCompareFeedback(uid, { pairId, winner, variants }) {
  const ref = db.collection('users').doc(String(uid))
    .collection('feedbackCompare').doc(String(pairId));
  await ref.set({
    winner,
    variants: variants || null, // {left:'A', right:'B'}
    updatedAt: nowTS(),
    createdAt: nowTS(),
  }, { merge: true });
}

// users/{uid}/feedbackCompareMeta/{pairId} : 입력 해시/변형명만 (출력 저장X)
async function logComparePairMeta(uid, { pairId, dateKey, inputHash, variants }) {
  const ref = db.collection('users').doc(String(uid))
    .collection('feedbackCompareMeta').doc(String(pairId));
  await ref.set({
    dateKey: String(dateKey || ''),
    inputHash: String(inputHash || ''),
    variants: variants || null,
    createdAt: nowTS(),
  }, { merge: true });
}



/* ─────────────────────────────────────────────
   11) 모듈 export
───────────────────────────────────────────── */
module.exports = {
  // CRUD
  addMessage,
  listConversations,
  listMessages,
  updateConversationTitle,
  updateConversationMeta,
  deleteConversationCascade,
  updateMessageText,

  // Calendar
  getCalendar,
  recomputeCalendar,

  // 분석/통계
  getEmotionsRange,
  getSessionDetailedAnalysis,
  getLastUserSnapshot,

  // Stage-2/멱등 유틸
  countUserMessages,
  findUserMessageByClientKey,
  findAssistantByCorrelation,

  // 캘리브레이션/피드백
  getCalibrationProfile,
  setCalibrationProfile,
  upsertFeedback,
  countFeedbackSamples,

  // 레거시 호환
  setUserRating,


  // 피드백 비교 저장
  saveCompareFeedback,
  logComparePairMeta,
};
