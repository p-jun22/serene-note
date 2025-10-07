// src/components/ChatBot.js
// 날짜별 대화 + 메시지 전송(/api/gpt/analyze) + 서버 집계 결과만 신뢰
// [핵심]
//  - 프론트는 Firestore 직접 접근 금지 → /api/* 만 사용
//  - /api/gpt/analyze 는 user 메시지를 "이미 저장"하므로, 동일 user 메시지를 또 저장하지 않는다
//  - assistant 응답(요약 포맷)만 별도로 /api/messages 로 1회 저장
//  - Optimistic UI 금지: 서버 응답 이후에만 로컬 상태 갱신
//  - 멱등성: clientMessageId(프론트 생성) → /gpt/analyze 로 전송, 같은 값을 correlationId 로 /messages 에 전달

import React, { useEffect, useMemo, useState } from "react";
import Message from "./Message";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import api from "../api";

/* ---------- KST YYYY-MM-DD (세션키) ---------- */
function ymdKST(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/* ---------- 멱등키(UUID) 생성 ---------- */
function makeClientMessageId() {
  try {
    if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID();
  } catch {}
  const rand = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${rand}`;
}

/* ---------- 이모지 매핑 (서버와 동일 로직) ---------- */
const EMOJI_MAP = {
  행복: "😊", 기쁨: "😊", 즐거움: "😊", 만족: "🙂",
  사랑: "🥰", 설렘: "🤩", 기대: "🤩",
  평온: "😌", 안정: "😌", 중립: "😐",
  불안: "😟", 걱정: "😟", 초조: "😟", 두려움: "😨", 공포: "😨",
  슬픔: "😢", 우울: "😞", 상실: "😢",
  분노: "😠", 짜증: "😠", 화: "😠",
  수치심: "😳", 부끄러움: "😳",
  피곤: "🥱", 지침: "🥱",
};
function pickEmojiFromEmotions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "😐";
  for (const label of arr) {
    const k = String(label || "").trim();
    if (EMOJI_MAP[k]) return EMOJI_MAP[k];
  }
  return "😐";
}

export default function ChatBot({ date, onBack }) {
  // 1) 세션 키(날짜)
  const dateKey = useMemo(() => ymdKST(date || new Date()), [date]);

  // 2) 인증 상태
  const [uidReady, setUidReady] = useState(false);

  // 3) 좌측 대화 목록 + 활성 대화
  const [convs, setConvs] = useState([]);         // [{id,title,moodEmoji,...}]
  const [activeId, setActiveId] = useState(null); // 현재 선택된 대화 id

  // 4) 우측 채팅
  const [messages, setMessages] = useState([]);   // [{id, role, text, ...}]
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // 5) 제목/메시지 편집 상태
  const [editingConvId, setEditingConvId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editingMsgId, setEditingMsgId] = useState(null);

  /* ─────────────────────────────────────────────
     A. 인증 관찰
     ─ 프론트 모든 요청은 Authorization 헤더(ID토큰) 필요
  ───────────────────────────────────────────── */
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUidReady(!!u);
    });
    return () => unsub();
  }, []);

  /* ─────────────────────────────────────────────
     B. 날짜 바뀌면 전체 스테이트 리셋
  ───────────────────────────────────────────── */
  useEffect(() => {
    setConvs([]);
    setActiveId(null);
    setMessages([]);
    setInput("");
    setEditingConvId(null);
    setEditTitle("");
    setEditingMsgId(null);
  }, [dateKey]);

  /* ─────────────────────────────────────────────
     C. 대화 목록 로드 (/api/conversations?sessionId=YYYY-MM-DD)
     ─ 서버가 보정/집계한 메타를 신뢰
  ───────────────────────────────────────────── */
  async function loadConversations(selectFirst = true) {
    if (!uidReady) return;
    try {
      const res = await api.get("/conversations", { params: { sessionId: dateKey } });
      const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
      setConvs(rows);
      if (selectFirst && rows.length && !activeId) {
        setActiveId(rows[0].id);
      }
    } catch (e) {
      console.error("loadConversations failed:", e?.response?.data || e);
      setConvs([]);
    }
  }
  useEffect(() => { loadConversations(true); /* eslint-disable-next-line */ }, [uidReady, dateKey]);

  /* ─────────────────────────────────────────────
     D. 메시지 로드 (/api/conversations/:id/messages?sessionId=...)
  ───────────────────────────────────────────── */
  async function loadMessages(cid) {
    if (!uidReady || !cid) { setMessages([]); return; }
    try {
      const res = await api.get(`/conversations/${cid}/messages`, {
        params: { sessionId: dateKey, limit: 1000 },
      });
      setMessages(Array.isArray(res?.data?.data) ? res.data.data : []);
    } catch (e) {
      console.error("loadMessages failed:", e?.response?.data || e);
      setMessages([]);
    }
  }
  useEffect(() => { loadMessages(activeId); /* eslint-disable-next-line */ }, [uidReady, dateKey, activeId]);

  /* ─────────────────────────────────────────────
     E. 새 대화 생성 (/api/conversations)
     ─ seed 메시지 없이 "대화 문서만" 생성(서버 정책)
  ───────────────────────────────────────────── */
  const handleNewConversation = async () => {
    if (!uidReady) { window.alert("로그인 후 이용해주세요."); return; }
    const title = window.prompt("대화 제목을 입력하세요 (예: 아침 생각)") || `${dateKey} 대화`;
    try {
      const res = await api.post("/conversations", { sessionId: dateKey, title: title.trim() });
      const id = res?.data?.id;
      // 서버가 최신 목록을 같이 돌려보내므로 그대로 반영
      const items = Array.isArray(res?.data?.data) ? res.data.data : [];
      setConvs(items);
      setActiveId(id || (items[0]?.id ?? null));
      setMessages([]);
      return id;
    } catch (e) {
      console.error("create conversation failed:", e?.response?.data || e);
      window.alert("대화 생성 실패");
      return null;
    }
  };

  /* ─────────────────────────────────────────────
     F. 제목 수정 (/api/conversations/:id PUT)
  ───────────────────────────────────────────── */
  const saveTitle = async (convId) => {
    try {
      await api.put(`/conversations/${convId}`, { sessionId: dateKey, title: editTitle.trim() });
      setEditingConvId(null);
      setEditTitle("");
      // 서버 집계 결과 반영을 위해 목록 재조회
      await loadConversations(false);
    } catch (e) {
      console.error("제목 수정 실패:", e?.response?.data || e);
      window.alert("제목 저장에 실패했습니다.");
    }
  };

  /* ─────────────────────────────────────────────
     G. 대화 삭제 (/api/conversations/:id DELETE)
  ───────────────────────────────────────────── */
  const deleteConversation = async (convId) => {
    if (!window.confirm("이 날짜의 해당 대화를 모두 삭제할까요?")) return;
    try {
      await api.delete(`/conversations/${convId}`, { params: { sessionId: dateKey } });
      // 목록 갱신
      await loadConversations(true);
      // 활성 대화가 삭제된 경우 메시지 비움
      if (activeId === convId) setMessages([]);
    } catch (e) {
      console.error("대화 삭제 실패:", e?.response?.data || e);
      window.alert("대화 삭제 중 문제가 발생했습니다.");
    }
  };

  /* ─────────────────────────────────────────────
     H. 메시지 전송
     1) /api/gpt/analyze  → 서버가 user 메시지 "저장"(멱등: clientMessageId 포함) + 스냅샷 반환
     2) assistant 텍스트 구성 → /api/messages 로 "한 번만" 저장(멱등: correlationId 포함)
     3) 목록/메시지 재조회 (Optimistic UI 금지)
  ───────────────────────────────────────────── */
  const handleSend = async () => {
    const content = String(input || "").trim();
    if (!content) return;
    if (!uidReady) { window.alert("로그인 후 이용해주세요."); return; }

    let convId = activeId;
    if (!convId) {
      convId = await handleNewConversation();
      if (!convId) return;
    }

    setLoading(true);
    setInput("");

    // (멱등키) 이 전송 건을 대표하는 clientMessageId 생성
    const clientMessageId = makeClientMessageId();

    try {
      // (1) 분석 + user 저장 (프론트는 중복 저장 금지!)
      const gptRes = await api.post("/gpt/analyze", {
        sessionId: dateKey,
        conversationId: convId,
        text: content,
        clientMessageId, // ← 멱등 키(같은 요청 재시도 시 동일 값 사용)
      });

      const snap = gptRes?.data?.analysisSnapshot_v1 || {};
      const out = snap?.llm?.output || {};
      const 감정 = Array.isArray(out["감정"]) ? out["감정"] : (Array.isArray(snap.emotions) ? snap.emotions : []);
      const 왜곡 = Array.isArray(out["인지왜곡"]) ? out["인지왜곡"] : (Array.isArray(snap.distortions) ? snap.distortions : []);
      const 핵심 = Array.isArray(snap.coreBeliefs) ? snap.coreBeliefs : (out["핵심믿음"] ? [out["핵심믿음"]] : []);
      const 질문 = Array.isArray(snap.recommendedQuestions) ? snap.recommendedQuestions : (out["추천질문"] ? [out["추천질문"]] : []);
      const conf = snap?.confidences || snap?.llm?.confidences || {};
      const moodEmoji = pickEmojiFromEmotions(감정);

      // (2) 보이는 assistant 텍스트 1줄 생성
      const llmLine =
        conf && Object.keys(conf).length
          ? `LLM 확신도 (감정/왜곡/핵심/질문): ${[
              conf.emotions,
              conf.distortions,
              conf.coreBelief,
              conf.question,
            ]
              .map((v) => (typeof v === "number" ? v.toFixed(2) : "-"))
              .join(" / ")}`
          : "LLM 확신도: -";

      const botText = [
        `[${dateKey}]`,
        `감정: ${감정.join(", ")}`,
        `인지 왜곡: ${왜곡.join(", ")}`,
        `핵심 믿음: ${핵심.join(", ")}`,
        `추천 질문: ${질문.join(", ")}`,
        "",
        "— 점수(분리 표시) —",
        llmLine,
        `HF emotions_avg / entropy: ${snap?.hf?.emotion?.avg ?? "-"} / ${snap?.hf?.emotion?.entropy ?? "-"}`,
        `HF NLI entail / contradict: ${snap?.hf?.nli?.core?.entail ?? "-"} / ${snap?.hf?.nli?.core?.contradict ?? "-"}`,
      ].join("\n");

      // (3) assistant 저장 — 딱 1번 (멱등: correlationId로 보호)
      await api.post("/messages", {
        sessionId: dateKey,
        conversationId: convId,
        message: { role: "assistant", text: botText, correlationId: clientMessageId },
      });

      // (4) 목록/메시지 재조회(서버 상태만 신뢰)
      await loadConversations(false);
      await loadMessages(convId);

      // (선택) 로컬 목록의 이모티콘 힌트만 즉시 반영
      setConvs((prev) => prev.map((c) => (c.id === convId ? { ...c, moodEmoji, moodLabels: 감정 } : c)));
    } catch (e) {
      const msg =
        e?.response?.data?.hint ||
        e?.response?.data?.message ||
        e?.response?.data?.error ||
        e?.message ||
        "unknown_error";
      console.error("전송 실패:", e?.response?.data || e);
      window.alert(`메시지 전송 실패: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  /* ─────────────────────────────────────────────
     I. 사용자 메시지 인라인 편집 (텍스트만 교체)
     ─ /api/messages/:id PATCH
  ───────────────────────────────────────────── */
  const handleStartEditMsg = (mid) => setEditingMsgId(mid);
  const handleCancelEditMsg = () => setEditingMsgId(null);
  const handleSaveEditMsg = async (mid, newText) => {
    try {
      await api.patch(`/messages/${mid}`, {
        sessionId: dateKey,
        conversationId: activeId,
        text: newText,
      });
      setEditingMsgId(null);
      await loadMessages(activeId); // 서버 반영 확인 후 재로드
    } catch (e) {
      console.error("메시지 수정 실패:", e?.response?.data || e.message);
      window.alert("메시지 수정에 실패했습니다.");
    }
  };

  const activeConv = convs.find((c) => c.id === activeId) || null;
  const headerTitle = activeConv
    ? `${activeConv.moodEmoji ? activeConv.moodEmoji + " " : ""}${activeConv.title || "(제목 없음)"}`
    : `${dateKey}`;

  /* ─────────────────────────────────────────────
     UI
  ───────────────────────────────────────────── */
  return (
    <div className="layout-chat">
      {/* 좌측: 대화 목록 */}
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="sidebar-date">{dateKey}</div>
          <button className="btn primary" onClick={handleNewConversation}>+ 새 대화</button>
        </div>

        <div className="conv-list">
          {convs.length === 0 ? (
            <div className="conv-empty">이 날짜의 대화가 없습니다. 새 대화를 시작해 보세요.</div>
          ) : (
            convs.map((c) => (
              <div key={c.id} className={`conv-item ${activeId === c.id ? "active" : ""}`}>
                {editingConvId === c.id ? (
                  <div className="conv-edit-row">
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      placeholder="제목"
                      className="conv-edit-input"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") { setEditingConvId(null); setEditTitle(""); }
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { saveTitle(c.id); }
                      }}
                    />
                    <div className="conv-edit-actions">
                      <button className="icon-btn solid" title="저장" onClick={() => saveTitle(c.id)}>💾</button>
                      <button className="icon-btn solid" title="취소" onClick={() => { setEditingConvId(null); setEditTitle(""); }}>✖</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button className="conv-main" onClick={() => setActiveId(c.id)} title={c.title}>
                      <div className="conv-title">{c.moodEmoji ? `${c.moodEmoji} ` : ""}{c.title}</div>
                      <div className="conv-sub">{dateKey}</div>
                    </button>
                    <button
                      className="icon-btn"
                      title="제목 수정"
                      onClick={() => { setEditingConvId(c.id); setEditTitle(c.title || ""); }}
                    >✏️</button>
                    <button
                      className="icon-btn"
                      title="삭제"
                      onClick={() => deleteConversation(c.id)}
                      aria-label="대화 삭제"
                    >🗑️</button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* 우측: 채팅 */}
      <section className="chat-container">
        <div className="toolbar">
          <div className="title">{headerTitle}</div>
          {onBack && <button className="btn" onClick={onBack}>◀ 캘린더로</button>}
        </div>

        <div className="chat-box">
          {messages.map((m) => (
            <Message
              key={m.id}
              id={m.id}
              role={m.role}
              text={m.text}
              editingId={editingMsgId}
              onStartEdit={m.role === 'assistant' ? undefined : handleStartEditMsg}
              onCancelEdit={handleCancelEditMsg}
              onSaveEdit={handleSaveEditMsg}
            />
          ))}
        </div>

        <div className="input-area">
          <input
            type="text"
            placeholder={activeId ? "메시지를 입력하세요..." : "먼저 새 대화를 생성하거나 기존 대화를 선택하세요."}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && handleSend()}
            disabled={!activeId || loading}
          />
          <button onClick={handleSend} disabled={!activeId || loading}>
            {loading ? "분석 중..." : "전송"}
          </button>
        </div>
      </section>
    </div>
  );
}
