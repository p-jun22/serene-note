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

export default function ChatBot({ date, onBack }) {
  const dateKey = useMemo(() => ymdKST(date || new Date()), [date]);

  const [uidReady, setUidReady] = useState(false);
  const [userEmail, setUserEmail] = useState(null);
  const isAdmin = (userEmail || "").toLowerCase() === "admin@gmail.com";

  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [editingConvId, setEditingConvId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editingMsgId, setEditingMsgId] = useState(null);

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
      const gptRes = await api.post("/gpt/analyze", {
        sessionId: dateKey,
        conversationId: convId,
        text: content,
        clientMessageId,
      });

      const snap = gptRes?.data?.analysisSnapshot_v1 || {};
      const out = snap?.llm?.output || {};
      const isSafety = !!snap?.safety?.selfHarm;

      const 감정 = Array.isArray(out["감정"]) ? out["감정"] : (Array.isArray(snap.emotions) ? snap.emotions : []);
      const 왜곡 = Array.isArray(out["인지왜곡"]) ? out["인지왜곡"] : (Array.isArray(snap.distortions) ? snap.distortions : []);
      const 핵심 = Array.isArray(snap.coreBeliefs) ? snap.coreBeliefs : (out["핵심믿음"] ? [out["핵심믿음"]] : []);
      const 질문 = Array.isArray(snap.recommendedQuestions) ? snap.recommendedQuestions : (out["추천질문"] ? [out["추천질문"]] : []);
      const conf = snap?.confidences || snap?.llm?.confidences || {};
      let botText;
      if (isSafety) {
        //  안전 모드: 경고 문구만 (다른 섹션/점수/라벨 전부 숨김)
        const crisis =
          snap?.safety?.message ||
          (Array.isArray(snap?.recommendedQuestions) ? snap.recommendedQuestions.join("\n") : "도움 요청 안내를 확인해 주세요.");
        botText = crisis;
      } else {
        const llmLine =
          conf && Object.keys(conf).length
            ? `LLM 확신도 (감정/왜곡/핵심/질문): ${[
              conf.emotions, conf.distortions, conf.coreBelief, conf.question,
            ].map((v) => (typeof v === "number" ? v.toFixed(2) : "-")).join(" / ")}`
            : "LLM 확신도: -";

        botText = [
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
      }

      await api.post("/messages", {
        sessionId: dateKey,
        conversationId: convId,
        message: { role: "assistant", text: botText, correlationId: clientMessageId },
      });

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

  // NEW: 피드백 전송을 Promise로 반환 → Message에서 await 가능
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
      throw e; // 실패로 알려줌
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

        <div className="chat-box">
          {messages.map((m) => (
            <Message
              key={m.id}
              id={m.id}
              role={m.role}
              text={m.text}
              editingId={editingMsgId}
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
              onRate={handleRateMessage} // NEW: Promise 반환
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
