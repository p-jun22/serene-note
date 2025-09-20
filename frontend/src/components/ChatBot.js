// ChatBot.js — 날짜별 대화: 좌측 목록(삭제 지원) + 우측 채팅
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Message from './Message';
import { onAuthStateChanged } from 'firebase/auth';
import {
  collection, addDoc, doc, setDoc, getDocs, deleteDoc,
  query, where, orderBy, serverTimestamp
} from 'firebase/firestore';
import { auth, db } from '../firebase'; // ★ auth/db 인스턴스 직접 사용

function ymdKST(d) {
  if (!(d instanceof Date)) d = new Date(d);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}
function getDateKeyFromRow(row) {
  if (typeof row?.dateKey === 'string' && row.dateKey.length >= 8) return row.dateKey;
  const secs = row?.createdAt?.seconds;
  const dt = secs ? new Date(secs * 1000) : new Date();
  return ymdKST(dt);
}

// 감정 → 이모지
const EMOJI_MAP = {
  행복: '😊', 기쁨: '😊', 즐거움: '😊', 만족: '🙂',
  사랑: '🥰', 설렘: '🤩', 기대: '🤩',
  평온: '😌', 안정: '😌', 중립: '😐',
  불안: '😟', 걱정: '😟', 초조: '😟', 두려움: '😨', 공포: '😨',
  슬픔: '😢', 우울: '😞', 상실: '😢',
  분노: '😠', 짜증: '😠', 화: '😠',
  수치심: '😳', 부끄러움: '😳',
  피곤: '🥱', 지침: '🥱',
};
const pickEmojiFromEmotions = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return '😐';
  for (const label of arr) {
    const clean = String(label).trim();
    if (EMOJI_MAP[clean]) return EMOJI_MAP[clean];
  }
  return '😐';
};

export default function ChatBot({ date, onBack }) {
  const dateKey = useMemo(() => ymdKST(date || new Date()), [date]);
  const [uid, setUid] = useState(null);
  const [userEmail, setUserEmail] = useState(null);

  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  // Auth (현재 로그인 사용자 구독)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUid(u?.uid || null);
      setUserEmail(u?.email || null);
    });
    return () => unsub();
  }, []);

  // 날짜 바뀔 때 초기화
  useEffect(() => {
    setConvs([]); setActiveId(null); setMessages([]); setInput('');
  }, [dateKey]);

  // 대화 목록 로드 (프론트 Firestore 그대로 사용)
  useEffect(() => {
    if (!uid) return;
    (async () => {
      let rows = [];
      const qByUid = query(collection(db, 'conversations'), where('uid', '==', uid));
      const s1 = await getDocs(qByUid);
      rows = s1.docs.map(d => ({ id: d.id, ...d.data() }));

      // 이전 데이터 호환: ownerEmail로도 한 번 더 조회
      if (rows.length === 0 && userEmail) {
        const qByEmail = query(collection(db, 'conversations'), where('ownerEmail', '==', userEmail));
        const s2 = await getDocs(qByEmail);
        rows = s2.docs.map(d => ({ id: d.id, ...d.data() }));
      }

      const filtered = rows
        .filter(r => getDateKeyFromRow(r) === dateKey)
        .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));

      setConvs(filtered);
      if (filtered.length) setActiveId(filtered[0].id);
    })();
  }, [uid, userEmail, dateKey]);

  // 메시지 로드 (프론트 Firestore 그대로 사용)
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    (async () => {
      const msgsRef = collection(db, 'conversations', activeId, 'messages');
      const q2 = query(msgsRef, orderBy('createdAt', 'asc'));
      const snap = await getDocs(q2);
      setMessages(snap.docs.map(d => d.data()));
    })();
  }, [activeId]);

  // 새 대화 생성 → 생성된 id 반환 (프론트 Firestore 그대로 사용)
  const handleNewConversation = async () => {
    if (!uid) {
      window.alert('로그인 후 이용해주세요.');
      return null;
    }
    const title = window.prompt('대화 제목을 입력하세요 (예: 아침 생각)') || `${dateKey} 대화`;
    const ref = await addDoc(collection(db, 'conversations'), {
      uid,
      ownerEmail: userEmail || null, // 이전 UID 대비 조회용
      dateKey,
      title,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    const newConv = { id: ref.id, uid, ownerEmail: userEmail || null, dateKey, title };
    setConvs(prev => [...prev, newConv]);
    setActiveId(ref.id);
    setMessages([]);
    return ref.id;
  };

  // 대화 삭제(하위 메시지 포함) — 프론트 Firestore 그대로
  const deleteConversation = async (convId) => {
    if (!convId) return;
    if (!window.confirm('이 대화를 삭제할까요? (메시지 포함)')) return;
    try {
      const msgsRef = collection(db, 'conversations', convId, 'messages');
      const msgSnap = await getDocs(msgsRef);
      await Promise.all(
        msgSnap.docs.map(m => deleteDoc(doc(db, 'conversations', convId, 'messages', m.id)))
      );
      await deleteDoc(doc(db, 'conversations', convId));
      setConvs(prev => prev.filter(c => c.id !== convId));
      if (activeId === convId) {
        const next = convs.find(c => c.id !== convId);
        setActiveId(next?.id || null);
        setMessages([]);
      }
    } catch (e) {
      console.error(e);
      window.alert('삭제 중 문제가 발생했습니다.');
    }
  };

  // 전송
  const handleSend = async () => {
    if (!input.trim()) return;
    if (!uid || !auth.currentUser) {
      window.alert('로그인 후 이용해주세요.');
      return;
    }

    // 새 대화 즉시 만들어서 id 받기
    let convId = activeId;
    if (!convId) {
      convId = await handleNewConversation();
      if (!convId) return;
    }
    setActiveId(convId);

    const userMsg = { sender: 'user', text: input.trim() };
    setMessages(prev => [...prev, { ...userMsg, createdAt: new Date() }]);

    // 프론트 Firestore에도 기록(기존 동작 유지)
    const msgsRef = collection(db, 'conversations', convId, 'messages');
    await addDoc(msgsRef, { ...userMsg, createdAt: serverTimestamp() });
    await setDoc(doc(db, 'conversations', convId), { updatedAt: serverTimestamp() }, { merge: true });

    setInput('');
    setLoading(true);

    try {
      // ⭐ 로그인 토큰 확보
      const token = await auth.currentUser.getIdToken();

      // 1) GPT 분석 API 호출 (토큰 포함)
      const res = await axios.post(
        'http://localhost:5000/api/gpt',
        { input: userMsg.text },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const { 감정 = [], 인지왜곡 = [], 핵심믿음 = '', 추천질문 = '' } = res.data || {};

      // 2) 챗봇 메시지 UI 반영 (총점 라인은 제거)
      const botText = `
[${dateKey}]
감정: ${Array.isArray(감정) ? 감정.join(', ') : ''}
인지 왜곡: ${Array.isArray(인지왜곡) ? 인지왜곡.join(', ') : ''}
핵심 믿음: ${핵심믿음 ?? ''}
추천 질문: ${추천질문 ?? ''}
`.trim();

      const botMsg = { sender: 'bot', text: botText };
      const moodEmoji = pickEmojiFromEmotions(Array.isArray(감정) ? 감정 : []);

      // 프론트 Firestore(기존) 업데이트
      await addDoc(msgsRef, { ...botMsg, createdAt: serverTimestamp() });
      await setDoc(doc(db, 'conversations', convId), {
        updatedAt: serverTimestamp(),
        lastBotAt: serverTimestamp(),
        moodEmoji,
        moodLabels: Array.isArray(감정) ? 감정 : [],
      }, { merge: true });

      setMessages(prev => [...prev, { ...botMsg, createdAt: new Date() }]);
      setConvs(prev => prev.map(c => c.id === convId ? { ...c, moodEmoji } : c));

      // 3) (옵션 권장) 백엔드에도 저장해 서버 집계 사용
      const analysisSnapshot_v1 = {
        emotions: Array.isArray(감정) ? 감정 : (감정 ? [감정] : []),
        distortions: Array.isArray(인지왜곡) ? 인지왜곡 : (인지왜곡 ? [인지왜곡] : []),
        coreBeliefs: 핵심믿음 ? [핵심믿음] : [],
        recommendedQuestions: 추천질문 ? [추천질문] : [],
        confidences: {} // (서버 계산/보정 예정)
      };

      await axios.post(
        'http://localhost:5000/api/messages',
        {
          sessionId: dateKey,
          conversationId: convId,
          message: {
            role: 'user',
            text: userMsg.text,
            analysisSnapshot_v1
          }
        },
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch((e) => {
        console.warn('서버 저장 실패(프론트 UI는 유지):', e?.response?.data || e?.message);
      });

    } catch (e) {
      console.error('API 호출 에러:', e);
      const errText = (e?.response?.data?.error === 'OPENAI_API_KEY not set')
        ? '서버에 OPENAI_API_KEY가 설정되어 있지 않습니다.'
        : '오류가 발생했어요!';
      const errMsg = { sender: 'bot', text: errText };
      setMessages(prev => [...prev, { ...errMsg, createdAt: new Date() }]);
      try {
        await addDoc(collection(db, 'conversations', activeId, 'messages'), {
          ...errMsg, createdAt: serverTimestamp()
        });
      } catch {}
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="layout-chat">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="sidebar-date">{dateKey}</div>
          <button className="btn primary" onClick={handleNewConversation}>+ 새 대화</button>
        </div>

        <div className="conv-list">
          {convs.length === 0 ? (
            <div className="conv-empty">이 날짜의 대화가 없습니다. 새 대화를 시작해 보세요.</div>
          ) : (
            convs.map(c => (
              <div key={c.id} className={`conv-item ${activeId === c.id ? 'active' : ''}`}>
                <button className="conv-main" onClick={() => setActiveId(c.id)} title={c.title}>
                  <div className="conv-title">{c.moodEmoji ? `${c.moodEmoji} ` : ''}{c.title}</div>
                  <div className="conv-sub">{getDateKeyFromRow(c)}</div>
                </button>
                <button
                  className="icon-btn"
                  title="삭제"
                  onClick={() => deleteConversation(c.id)}
                  aria-label="대화 삭제"
                >
                  🗑️
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="chat-container">
        <div className="toolbar">
          <div className="title">{dateKey} 대화</div>
          {onBack && <button className="btn" onClick={onBack}>◀ 캘린더로</button>}
        </div>

        <div className="chat-box">
          {messages.map((m, i) => (
            <Message key={i} sender={m.sender} text={m.text} />
          ))}
        </div>

        <div className="input-area">
          <input
            type="text"
            placeholder="메시지를 입력하세요... (미선택 상태에서 전송하면 새 대화를 만듭니다)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && handleSend()}
            disabled={loading}
          />
          <button onClick={handleSend} disabled={loading}>
            {loading ? '추론 중...' : '전송'}
          </button>
        </div>
      </section>
    </div>
  );
}
