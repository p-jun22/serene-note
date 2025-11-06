// src/components/ChatBot.js
// 날짜별 대화 + 메시지 전송(/api/gpt/analyze) + 서버 집계 결과만 신뢰

import React, { useEffect, useMemo, useState } from "react";
import Message from "./Message";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import api from "../api";
import { postFeedback } from "../api";

function ymdKST(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function makeClientMessageId() {
  try { if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID(); } catch { }
  const rand = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${rand}`;
}

export default function ChatBot({ date, onBack }) {
  const dateKey = useMemo(() => ymdKST(date || new Date()), [date]);

  const [uidReady, setUidReady] = useState(false);
  const [userEmail, setUserEmail] = useState(null);
  // 계정 => 모드 분기
  const email = (userEmail || "").toLowerCase();
  const BASELINE_EMAIL = "basic@gmail.com";
  const ADMIN_EMAIL = "admin@gmail.com";
  const isBaseline = email === BASELINE_EMAIL;
  const isAdmin = email === ADMIN_EMAIL;
  const mode = isBaseline ? "baseline" : (isAdmin ? "admin" : "user");

  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [editingConvId, setEditingConvId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editingMsgId, setEditingMsgId] = useState(null);

  // 안전문구 감지(프론트 보조용) – 서버 저장 텍스트 기반
  const SAFETY_RE = /이 앱은 당신의 안전|1393|109|1388|보건복지상담|자살예방상담/;

  // 최근 user 메시지 텍스트(입력창이 비었을 때 A/B 입력으로 사용)
  const lastUserText = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "user" && typeof m?.text === "string") {
        const t = m.text.trim();
        if (t) return t;
      }
    }
    return "";
  }, [messages]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUidReady(!!u);
      setUserEmail(u?.email || null);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    setConvs([]); setActiveId(null); setMessages([]); setInput("");
    setEditingConvId(null); setEditTitle(""); setEditingMsgId(null);
  }, [dateKey]);

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

  const handleNewConversation = async () => {
    if (!uidReady) { window.alert("로그인 후 이용해`주세요."); return; }
    const title = window.prompt("대화 제목을 입력하세요 (예: 아침 생각)") || `${dateKey} 대화`;
    try {
      const res = await api.post("/conversations", { sessionId: dateKey, title: title.trim() });
      const id = res?.data?.id;
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

  const saveTitle = async (convId) => {
    try {
      await api.put(`/conversations/${convId}`, { sessionId: dateKey, title: editTitle.trim() });
      setEditingConvId(null); setEditTitle("");
      await loadConversations(false);
    } catch (e) {
      console.error("제목 수정 실패:", e?.response?.data || e);
      window.alert("제목 저장에 실패했습니다.");
    }
  };

  const deleteConversation = async (convId) => {
    if (!window.confirm("이 날짜의 해당 대화를 모두 삭제할까요?")) return;
    try {
      await api.delete(`/conversations/${convId}`, { params: { sessionId: dateKey } });
      await loadConversations(true);
      if (activeId === convId) setMessages([]);
    } catch (e) {
      console.error("대화 삭제 실패:", e?.response?.data || e);
      window.alert("대화 삭제 중 문제가 발생했습니다.");
    }
  };

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

    const clientMessageId = makeClientMessageId();

    try {
      await api.post("/gpt/analyze", {
        sessionId: dateKey,
        conversationId: convId,
        text: content,
        clientMessageId,
      });
      // 서버가 저장 끝냈으니 화면만 새로고침
      await loadConversations(false);
      await loadMessages(convId);

    } catch (e) {
      const msg = e?.response?.data?.hint || e?.response?.data?.message || e?.response?.data?.error || e?.message || "unknown_error";
      console.error("전송 실패:", e?.response?.data || e);
      window.alert(`메시지 전송 실패: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  function ABCard({ result }) {
    const text = result?.llm?.text?.trim();
    const pretty = (() => {
      try {
        const o = result?.llm?.output;
        if (!o) return "";
        const emo = Array.isArray(o["감정"]) ? o["감정"].join(", ") : "";
        const dist = Array.isArray(o["인지왜곡"]) ? o["인지왜곡"].join(", ") : "";
        const core = o["핵심믿음"] || "";
        const q = o["추천질문"] || "";
        return [
          emo && `• 감정: ${emo}`,
          dist && `• 인지왜곡: ${dist}`,
          core && `• 핵심믿음: ${core}`,
          q && `• 추천질문: ${q}`,
        ].filter(Boolean).join("\n");
      } catch { return ""; }
    })();
    const fallback = JSON.stringify(result?.llm?.output ?? result, null, 2);
    return <pre className="bubble" style={{ whiteSpace: 'pre-wrap' }}>{text || pretty || fallback}</pre>;
  }

  function ComparePanel({ isAdmin, inputText }) {
    const [left, setLeft] = React.useState(null);
    const [right, setRight] = React.useState(null);
    const [pairId, setPairId] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    if (!isAdmin) return null;

    const runCompare = async () => {
      if (!inputText?.trim()) {
        window.alert("입력창에 문장을 쓰거나, 직전 사용자 메시지가 있어야 비교를 생성할 수 있어요.");
        return;
      }
      setBusy(true);
      try {
        const { data } = await api.post("/gpt/compare", {
          text: inputText, variantA: "A", variantB: "B"
        });
        if (data?.ok) {
          setPairId(data.pairId);
          setLeft(data.left);
          setRight(data.right);
        } else {
          window.alert(`비교 생성 실패: ${data?.error || "unknown"}`);
        }
      } catch (e) {
        console.error("compare error:", e?.response?.data || e);
        window.alert(`비교 생성 실패: ${e?.response?.data?.error || e.message}`);
      } finally {
        setBusy(false);
      }
    };

    const submitWinner = async (side) => {
      try {
        await api.post("/feedback/compare", {
          pairId, winner: side, variants: { left: "A", right: "B" }
        });
        setPairId(null); setLeft(null); setRight(null);
      } catch (e) {
        console.error("compare/feedback error:", e?.response?.data || e);
        window.alert(`승자 저장 실패: ${e?.response?.data?.error || e.message}`);
      }
    };

    return (
      <div className="compare-panel">
        <div className="ab-actions">
          <button className="ab-btn" onClick={runCompare} disabled={busy}>
            {busy ? "비교 생성 중…" : "비교 생성(A/B)"}
          </button>
        </div>

        {left && right && (
          <div className="compare-result">
            <div className="compare-col">
              <ABCard result={left} />
              <button className="pick" disabled={!pairId || busy} onClick={() => submitWinner('left')}>⬅ 이쪽이 더 좋음</button>
            </div>
            <div className="compare-col">
              <ABCard result={right} />
              <button className="pick" disabled={!pairId || busy} onClick={() => submitWinner('right')}>이쪽이 더 좋음 ➡</button>
            </div>
          </div>
        )}
      </div>
    );
  }



  // 피드백 전송을 Promise로 반환 => Message에서 await 가능
  const handleRateMessage = async (messageId, score) => {
    if (!activeId || !dateKey || !messageId) return Promise.resolve(false);
    try {
      await postFeedback({
        messageId,
        dateKey,
        conversationId: activeId,
        score,
      });
      return true; // 성공
    } catch (e) {
      console.error("피드백 전송 실패:", e?.response?.data || e);
      window.alert("피드백 전송에 실패했습니다.");
      throw e; // 실패
    }
  };

  const activeConv = convs.find((c) => c.id === activeId) || null;
  const headerTitle = activeConv
    ? `${activeConv.moodEmoji ? activeConv.moodEmoji + " " : ""}${activeConv.title || "(제목 없음)"}`
    : `${dateKey}`;

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
                    <button className="icon-btn" title="제목 수정" onClick={() => { setEditingConvId(c.id); setEditTitle(c.title || ""); }}>✏️</button>
                    <button className="icon-btn" title="삭제" onClick={() => deleteConversation(c.id)} aria-label="대화 삭제">🗑️</button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="chat-container">
        <div className="toolbar">
          <div className="title">{headerTitle}</div>
          {onBack && <button className="btn" onClick={onBack}>◀ 캘린더로</button>}
        </div>
        {/* 배지: 안전모드 우선 표시 => 아니면 Stage-1/2 */}
        {(() => {
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          const looksSafety = lastAssistant ? SAFETY_RE.test(lastAssistant.text || '') : false;
          const userTurns = messages.filter(m => m.role === 'user').length;
          const isCoaching = !isBaseline && userTurns >= 2;
          const badgeText = looksSafety ? '안전 안내 모드' : (isCoaching ? '코칭 모드(Stage-2)' : '요약 모드(Stage-1)');
          const badgeStyle = looksSafety
            ? { background: '#fff7e6', border: '1px solid #ffd591' }
            : (isCoaching ? { background: '#e6f7ff', border: '1px solid #91d5ff' } : { background: '#f6ffed', border: '1px solid #b7eb8f' });
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 8px' }}>
              <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 12, color: '#555', ...badgeStyle }}>
                {badgeText}
              </span>
            </div>
          );
        })()}
        <ComparePanel isAdmin={isAdmin} inputText={input || lastUserText} />


        <div className="chat-box">
          {messages.map((m) => (
            <Message
              key={m.id}
              id={m.id}
              role={m.role}
              text={m.text}
              mode={mode}
              editingId={editingMsgId}
              // 안전문구일 때(admin x) 강제로 숨김
              forceHideFeedback={!isAdmin && m.role === 'assistant' && SAFETY_RE.test(m.text || '')}
              onStartEdit={m.role === 'assistant' ? undefined : (id) => setEditingMsgId(id)}
              onCancelEdit={() => setEditingMsgId(null)}
              onSaveEdit={async (mid, newText) => {
                try {
                  await api.patch(`/messages/${mid}`, { sessionId: dateKey, conversationId: activeId, text: newText });
                  setEditingMsgId(null);
                  await loadMessages(activeId);
                } catch (e) {
                  console.error("메시지 수정 실패:", e?.response?.data || e.message);
                  window.alert("메시지 수정에 실패했습니다.");
                }
              }}
              isAdmin={isAdmin}
              onRate={handleRateMessage}
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
