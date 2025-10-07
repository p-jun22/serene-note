// backend/services/firestoreRepository.js
// ─────────────────────────────────────────────────────────────
// [역할 요약]
// 1) Firestore I/O 단일 창구 (대화/메시지 CRUD)
// 2) 캘린더 집계(recomputeCalendar) - ★ 레거시 루트 미러 완전 제거
// 3) 분석/그래프용 조회 유틸 (세션 월 범위 조회 등)
// 4) Stage-2/멱등성 준비 유틸(countUserMessages 등)
//
// [핵심 정책 반영]
// - 경로 스키마(불변):
//   users/{uid}/sessions/{dateKey}/conversations/{cid}/messages/{mid}
//   users/{uid}/sessions/{dateKey}/calendar/summary     ← ★ 단일 SOT
// - 레거시(users/{uid}/calendar/{dateKey}) 경로: ★ 완전 폐기 (읽기/쓰기 모두 금지)
// - 서버 시간은 FieldValue.serverTimestamp()만 사용 (클라 시간 금지)
// - 집계 필요 변경 시 recomputeCalendar(uid, dateKey) 반드시 호출
// ─────────────────────────────────────────────────────────────

const { admin, db } = require('../firebaseAdmin');
const { FieldValue, FieldPath } = admin.firestore;

/* ─────────────────────────────────────────────
   1) 경로 헬퍼 (Tree.txt 기준, 이름/구조 변경 금지)
───────────────────────────────────────────── */
function userDoc(uid){ return db.collection('users').doc(String(uid)); }
function sessionDoc(uid, dateKey){ return userDoc(uid).collection('sessions').doc(String(dateKey)); }
function conversationsCol(uid, dateKey){ return sessionDoc(uid, dateKey).collection('conversations'); }
function conversationDoc(uid, dateKey, cid){ return conversationsCol(uid, dateKey).doc(String(cid)); }
function messagesCol(uid, dateKey, cid){ return conversationDoc(uid, dateKey, cid).collection('messages'); }
// 캘린더 요약(SOT): 세션 하위 summary 하나만 사용
function calendarSummaryDoc(uid, dateKey){ return sessionDoc(uid, dateKey).collection('calendar').doc('summary'); }

/* ─────────────────────────────────────────────
   2) 공용 유틸
───────────────────────────────────────────── */
function nowTS(){ return FieldValue.serverTimestamp(); }
const num = (x)=>{ const n = Number(x); return Number.isFinite(n) ? n : null; };
function pushCount(map, k, n=1){ if(!k) return; map[k]=(map[k]||0)+n; }

const EMOJI = {
  행복:'😊', 기쁨:'😊', 즐거움:'😊', 만족:'🙂',
  사랑:'🥰', 설렘:'🤩', 기대:'🤩',
  평온:'😌', 안정:'😌', 중립:'😐',
  불안:'😟', 걱정:'😟', 초조:'😟', 두려움:'😨', 공포:'😨',
  슬픔:'😢', 우울:'😞', 상실:'😢',
  분노:'😠', 짜증:'😠', 화:'😠',
  수치심:'😳', 부끄러움:'😳',
  피곤:'🥱', 지침:'🥱',
};
function pickEmojiFromLabels(arr){
  if(!Array.isArray(arr)||!arr.length) return '😐';
  for(const l of arr){ const k=String(l||'').trim(); if(EMOJI[k]) return EMOJI[k]; }
  return '😐';
}

/* ─────────────────────────────────────────────
   3) 스냅샷 파서(호환 강화)
   - 입력: analysisSnapshot_v1(snap), hf_raw(선택)
   - 스키마 키는 절대 변경 금지(기존 명세 유지)
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
    emotions:    num(c.emotions),
    distortions: num(c.distortions),
    coreBelief:  num(c.coreBelief),
    question:    num(c.question),
  };

  const hf = {
    emotions_avg:    num(snap?.hf?.emotion?.avg        ?? hf_raw?.emotions_avg ?? hf_raw?.emotion?.avg),
    emotion_entropy: num(snap?.hf?.emotion?.entropy    ?? hf_raw?.emotion_entropy ?? hf_raw?.emotion?.entropy),
    core_entail:     num(snap?.hf?.nli?.core?.entail   ?? hf_raw?.nli_core?.entail ?? hf_raw?.nli?.core?.entail),
    core_contradict: num(snap?.hf?.nli?.core?.contradict ?? hf_raw?.nli_core?.contradict ?? hf_raw?.nli?.core?.contradict),
  };

  return { emotions, distortions, coreBeliefs, questions, llm, hf };
}

/* ─────────────────────────────────────────────
   4) 캘린더 집계 (★ 레거시 루트 미러 완전 제거)
   - 저장 위치: users/{uid}/sessions/{dateKey}/calendar/summary 단일
   - 필드 이름: convSet, count, moodCounters, lastEmoji, topEmoji, updatedAt (고정)
───────────────────────────────────────────── */
async function recomputeCalendar({ uid, sessionId }) {
  const convSnap = await conversationsCol(uid, sessionId).get();

  const convSet = {};
  const moodCounters = {};
  let lastEmoji = '📝';
  let lastTs = 0;

  convSnap.forEach((d) => {
    const v = d.data() || {};
    convSet[d.id] = true;

    const labels = Array.isArray(v.moodLabels) ? v.moodLabels : [];
    labels.forEach((lb) => pushCount(moodCounters, lb));

    const ts = v.lastBotAt?.toMillis?.() || v.updatedAt?.toMillis?.() || v.createdAt?.toMillis?.() || 0;
    if (ts >= lastTs && labels.length) {
      lastTs = ts;
      lastEmoji = pickEmojiFromLabels(labels);
    }
  });

  // 최빈 라벨 → topEmoji
  let topEmoji = '📝', max=-1, topLabel=null;
  for (const [label,count] of Object.entries(moodCounters)) {
    if (count > max) { max=count; topLabel=label; }
  }
  if (topLabel) topEmoji = pickEmojiFromLabels([topLabel]);

  const payload = {
    uid,                 // collectionGroup 쿼리용
    dateKey: sessionId,  // collectionGroup 범위 필터용
    convSet,
    count: Object.keys(convSet).length,
    moodCounters,
    lastEmoji,
    topEmoji,
    updatedAt: nowTS(),
  };

  await calendarSummaryDoc(uid, sessionId).set(payload, { merge: true });
  return payload;
}

/* ─────────────────────────────────────────────
   5) 캘린더 범위 조회 (월 단위 등)
   - collectionGroup('calendar')에서 uid/dateKey로 필터
   - 루트(users/{uid}/calendar) 레거시 사용 ❌
───────────────────────────────────────────── */
async function getCalendar({ uid, startDateKey, endDateKey }) {
  const start = startDateKey ? String(startDateKey).slice(0,10) : null;
  const end   = endDateKey   ? String(endDateKey).slice(0,10)   : null;

  // sessions/*/calendar/summary 문서들만 모으는 group 쿼리
  let q = db.collectionGroup('calendar')
            .where('uid', '==', uid);

  if (start) q = q.where('dateKey', '>=', start);
  if (end)   q = q.where('dateKey', '<=', end);

  const snap = await q.get();
  const map = {};
  snap.forEach((doc) => {
    const v = doc.data() || {};
    const k = v.dateKey || '0000-00-00';
    // summary 한 종류만 존재하므로 추가 필터 불필요
    map[k] = {
      dateKey: k,
      // emoji 대표는 topEmoji 우선 → lastEmoji → null
      emoji: v.topEmoji || v.lastEmoji || null,
      convSet: v.convSet || {},
      count: v.count ?? (v.convSet ? Object.keys(v.convSet).length : 0),
      moodLabels: Array.isArray(v.moodLabels) ? v.moodLabels : [], // 호환 필드(있으면 그대로)
      touchedAt: v.updatedAt || null,
    };
  });

  return map;
}

/* ─────────────────────────────────────────────
   6) 메시지/대화 CRUD
   - addMessage: 대화 존재 보장 + 메시지 저장 + 메타 갱신 + 캘린더 집계
   - assistant에는 snapshot/hf_raw 저장 금지(방어)
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

  // 메타 갱신용 벡터 추출(호환 파서)
  const vec = snap ? extractSnapshotVectors(snap, hf_raw) : { emotions:[], distortions:[], coreBeliefs:[] };

  await db.runTransaction(async (tx) => {
    const convSnap = await tx.get(convRef);

    // (1) 대화 문서 보장 (★ seed 메시지 없이 문서만)
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

    // (2) 메시지 저장 (assistant에는 snapshot/hf_raw 저장 금지)
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
    const updates = { updatedAt: now };
    if (role === 'assistant') {
      updates.lastBotAt = now;
    } else if (role === 'user' && snap) {
      const labels = Array.isArray(vec.emotions) ? vec.emotions : [];
      const moodEmoji = pickEmojiFromLabels(labels);
      updates.moodLabels = labels;
      updates.moodEmoji = moodEmoji;
      updates.distortions = Array.isArray(vec.distortions) ? vec.distortions : [];
      updates.coreBeliefs = Array.isArray(vec.coreBeliefs) ? vec.coreBeliefs : [];
    }
    tx.set(convRef, updates, { merge: true });

    // (4) 세션 터치 (조회 인덱싱용 키 유지)
    tx.set(sessRef, { dateKey: sessionId, touchedAt: now }, { merge: true });
    // 캘린더 summary는 recompute에서 일괄 갱신
  });

  // (5) 집계 재계산
  await recomputeCalendar({ uid, sessionId });
  return { ok: true };
}

/** 세션별 대화 목록 */
async function listConversations({ uid, sessionId, limit = 100 }) {
  const snap = await conversationsCol(uid, sessionId).orderBy('createdAt','asc').limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** 특정 대화의 메시지 목록 */
async function listMessages({ uid, sessionId, conversationId, limit = 1000 }) {
  const snap = await messagesCol(uid, sessionId, conversationId).orderBy('createdAt','asc').limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** 대화 제목 변경(+ 집계 재계산) */
async function updateConversationTitle({ uid, sessionId, conversationId, title }) {
  await conversationDoc(uid, sessionId, conversationId)
    .set({ title: String(title||'').trim(), updatedAt: nowTS() }, { merge: true });
  await recomputeCalendar({ uid, sessionId });
  return { ok: true };
}

/** 대화 메타 패치(note 등) */
async function updateConversationMeta({ uid, dateKey, conversationId, patch }) {
  const convRef = conversationDoc(uid, dateKey, conversationId);
  await convRef.set({ ...patch, updatedAt: nowTS() }, { merge: true });
  return { ok: true };
}

/** 대화 삭제(메시지 일괄) + 집계 재계산 */
async function deleteConversationCascade({ uid, sessionId, conversationId }) {
  const convRef = conversationDoc(uid, sessionId, conversationId);

  // 1) 메시지 삭제(배치)
  const msgs = await messagesCol(uid, sessionId, conversationId).get();
  const CHUNK = 400;
  for (let i=0;i<msgs.docs.length;i+=CHUNK){
    const batch = db.batch();
    msgs.docs.slice(i,i+CHUNK).forEach(m=>batch.delete(m.ref));
    await batch.commit();
  }

  // 2) 대화 삭제
  await convRef.delete();

  // 3) 캘린더 재계산(★ count 잔존 방지)
  await recomputeCalendar({ uid, sessionId });
  return { ok:true };
}

/**
 * 사용자 메시지 텍스트 수정 (assistant 금지)
 * @throws {Error} 'bad_params' | 'not_found' | { code:'forbidden' }
 */
async function updateMessageText(uid, sessionId, conversationId, messageId, text) {
  const { admin } = require('../firebaseAdmin');
  const { FieldValue } = admin.firestore;

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

  // 메시지 본문만 교체 + 업데이트 타임스탬프
  await msgRef.set({
    text: String(text || ''),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // 대화 문서의 updatedAt만 갱신 (집계 변경 없음)
  await conversationDoc(uid, sessionId, conversationId)
    .set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true };
}


/* ─────────────────────────────────────────────
   7) 분석/통계 보조 유틸 (그래프/정확도 페이지용)
───────────────────────────────────────────── */
function avg(xs){ const a=(xs||[]).filter(Number.isFinite); if(!a.length) return null; return a.reduce((p,c)=>p+c,0)/a.length; }
const toFixedOrNull = (n,p=2)=> (Number.isFinite(n)? +n.toFixed(p): null);

/** 감정 범위 요약(세션별 user 메시지 기반) */
async function getEmotionsRange({ uid, from, to, maxConversations = 500, maxMessagesPerConv = 400 }) {
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
        .where('role','==','user')
        .orderBy('createdAt','asc')
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

/** 세션 상세 분석(라벨 분포/평균 신뢰도/HF 요약) */
async function getSessionDetailedAnalysis({ uid, dateKey, maxConversations = 800, maxMessages = 1200 }) {
  const convRefs = await conversationsCol(uid, dateKey).listDocuments();
  const use = convRefs.slice(0, maxConversations);

  const counts = { emotions:{}, distortions:{}, coreBeliefs:{}, questions:{} };
  const llm = { emotions:[], distortions:[], coreBelief:[], question:[] };
  const hf = { emotions_avg:[], emotion_entropy:[], core_entail:[], core_contradict:[] };

  let messageTotal = 0;
  for (const c of use) {
    const msgSnap = await c.collection('messages').where('role','==','user').orderBy('createdAt','asc').limit(maxMessages).get();
    msgSnap.forEach(doc => {
      const d = doc.data() || {}; messageTotal += 1;
      const v = extractSnapshotVectors(d.analysisSnapshot_v1 || {}, d.hf_raw || {});
      (v.emotions||[]).forEach(e => pushCount(counts.emotions, e));
      (v.distortions||[]).forEach(e => pushCount(counts.distortions, e));
      (v.coreBeliefs||[]).forEach(e => pushCount(counts.coreBeliefs, e));
      (v.questions||[]).forEach(e => pushCount(counts.questions, e));

      if (v.llm) {
        if (v.llm.emotions!=null) llm.emotions.push(v.llm.emotions);
        if (v.llm.distortions!=null) llm.distortions.push(v.llm.distortions);
        if (v.llm.coreBelief!=null) llm.coreBelief.push(v.llm.coreBelief);
        if (v.llm.question!=null) llm.question.push(v.llm.question);
      }
      if (v.hf) {
        if (v.hf.emotions_avg!=null) hf.emotions_avg.push(v.hf.emotions_avg);
        if (v.hf.emotion_entropy!=null) hf.emotion_entropy.push(v.hf.emotion_entropy);
        if (v.hf.core_entail!=null) hf.core_entail.push(v.hf.core_entail);
        if (v.hf.core_contradict!=null) hf.core_contradict.push(v.hf.core_contradict);
      }
    });
  }

  return {
    dateKey,
    totals: { conversations: use.length, messages: messageTotal },
    top: {
      emotions: Object.entries(counts.emotions).sort((a,b)=>b[1]-a[1]).map(([label,count])=>({label,count})),
      distortions: Object.entries(counts.distortions).sort((a,b)=>b[1]-a[1]).map(([label,count])=>({label,count})),
      coreBeliefs: Object.entries(counts.coreBeliefs).sort((a,b)=>b[1]-a[1]).map(([label,count])=>({label,count})),
      questions: Object.entries(counts.questions).sort((a,b)=>b[1]-a[1]).map(([label,count])=>({label,count})),
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
   8) Stage-2/멱등성 준비 유틸 (routes/api 에서 사용)
───────────────────────────────────────────── */

/** 해당 대화의 user 메시지 개수(= Stage-2 트리거 판정용) */
async function countUserMessages({ uid, sessionId, conversationId }) {
  const snap = await messagesCol(uid, sessionId, conversationId).where('role','==','user').get();
  return snap.size || 0;
}

/** clientMessageId로 user 메시지 중복 검사(멱등성) */
async function findUserMessageByClientKey({ uid, sessionId, conversationId, clientMessageId }) {
  if (!clientMessageId) return null;
  const snap = await messagesCol(uid, sessionId, conversationId)
    .where('role','==','user')
    .where('clientMessageId','==', String(clientMessageId))
    .limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

/** assistant 상관키(correlationId)로 중복 검사 */
async function findAssistantByCorrelation({ uid, sessionId, conversationId, correlationId }) {
  if (!correlationId) return null;
  const snap = await messagesCol(uid, sessionId, conversationId)
    .where('role','==','assistant')
    .where('correlationId','==', String(correlationId))
    .limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}


// ─────────────────────────────────────────────────────────────
// [Calibration Profile] 사용자별 캘리브레이션 파라미터 SOT
// 경로: users/{uid}/profile/calibration  (스키마 합의대로)
// - method: 'platt' | 'isotonic'
// - task.<name>.{a,b,bins[],map[]}  (Platt 또는 Isotonic 중 하나만 사용)
// - fusion: { wLLM, wHF, tauLLM, tauHF }
// - quality: { ece{}, brier{}, samples }
// 서버시간은 항상 FieldValue.serverTimestamp() 사용
// ─────────────────────────────────────────────────────────────
async function getCalibrationProfile(uid) {
  if (!uid) throw new Error('bad_params');
  const ref = db.collection('users').doc(String(uid))
    .collection('profile').doc('calibration');
  const snap = await ref.get();
  return snap.exists ? { id: ref.id, ...snap.data() } : null;
}

async function setCalibrationProfile(uid, profile) {
  if (!uid || !profile || typeof profile !== 'object') throw new Error('bad_params');
  const { admin } = require('../firebaseAdmin');
  const { FieldValue } = admin.firestore;
  const ref = db.collection('users').doc(String(uid))
    .collection('profile').doc('calibration');
  await ref.set({
    ...profile,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
}

// 추가 2: 피드백 저장(멱등)
// ─────────────────────────────────────────────────────────────
// [Feedback] 사용자 확정/평점 피드백 저장
// 경로: users/{uid}/feedback/{messageId}   (세션/대화 이동과 독립)
// - ratings.useful: 0~5 (정수)  → 서버에서 y=ratings/5로 변환해 학습에 사용
// - labels: { emotions[], distortions[], coreBelief, question? } (옵션)
// - tieTo: { dateKey, conversationId }  (조회 편의)
// 멱등: messageId 동일 시 덮어쓰기
// ─────────────────────────────────────────────────────────────
async function upsertFeedback(uid, messageId, payload) {
  if (!uid || !messageId) throw new Error('bad_params');
  const ref = db.collection('users').doc(String(uid))
    .collection('feedback').doc(String(messageId));
  const snap = await ref.get();
  const exists = snap.exists;
  await ref.set({
    ...payload,
  }, { merge: true });
  return { ok: true, upserted: true, existed: exists };
}

 // 추가 3: 피드백 샘플 개수(간단 통계)
// 개수만 빠르게 확인(캘리브레이션 승격 임계 판단용)
async function countFeedbackSamples(uid) {
  if (!uid) throw new Error('bad_params');
  const col = db.collection('users').doc(String(uid)).collection('feedback');
  const snap = await col.get();
  return { count: snap.size || 0 };
}



/* ─────────────────────────────────────────────
   9) 모듈 export
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

  // Stage-2/멱등 유틸
  countUserMessages,
  findUserMessageByClientKey,
  findAssistantByCorrelation,
  getCalibrationProfile,
  setCalibrationProfile,
  upsertFeedback,
  countFeedbackSamples,
};
