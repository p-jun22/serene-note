// backend/firestoreRepository.js
// Firebase Admin을 통한 읽기/쓰기 레이어
const admin = require('../firebaseAdmin');
const db = admin.firestore();

/**
 * 대화 문서 스키마(프론트 Firestore와 호환):
 * collection('conversations') 에 문서:
 *  { uid, ownerEmail?, dateKey, title?, moodEmoji?, moodLabels?: string[], createdAt?, updatedAt?, lastBotAt? }
 *  하위 subcollection('messages')에 메시지 저장
 */

// KST 문자열(YYYY-MM-DD) 범위 조회용 보정
function isInRange(dateKey, start, end) {
  return dateKey >= start && dateKey <= end;
}

// 날짜 범위로 대화 목록(uid 필터)
async function listConversationsByDateRange(uid, startDateKey, endDateKey) {
  // uid로 먼저 필터
  const snap = await db.collection('conversations').where('uid', '==', uid).get();

  const out = [];
  snap.forEach(doc => {
    const data = doc.data() || {};
    if (!data.dateKey) return;
    if (isInRange(data.dateKey, startDateKey, endDateKey)) {
      out.push({ id: doc.id, ...data });
    }
  });
  return out;
}

// 특정 날짜에 대화 존재 여부
async function existsConversationOn(uid, dateKey) {
  const snap = await db.collection('conversations')
    .where('uid', '==', uid)
    .where('dateKey', '==', dateKey)
    .limit(1)
    .get();
  return !snap.empty;
}

// 서버 권위 메시지 저장(선택)
async function appendMessage(uid, sessionId, conversationId, message) {
  const root = db.collection('conversations').doc(conversationId).collection('messages');
  // 최소 필드
  const docRef = await root.add({
    ...message,
    uid,
    sessionId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return docRef.id;
}

// 대화 문서 최소 보정(upsert)
async function upsertConversation(uid, partial) {
  if (!partial?.id) return;
  const ref = db.collection('conversations').doc(partial.id);
  await ref.set(
    {
      uid,
      ...partial,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

module.exports = {
  listConversationsByDateRange,
  existsConversationOn,
  appendMessage,
  upsertConversation,
};
