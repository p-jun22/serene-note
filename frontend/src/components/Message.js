// src/components/Message.js
// 단일 메시지 렌더 + 인라인 편집 (사용자 메시지만)
// ---------------------------------------------------------------------------
// - role === 'user' 인 경우에만 ✏️ 아이콘 노출
// - 편집 모드 단축키: Ctrl/Cmd+Enter = 저장, ESC = 취소
// - 스타일: App.css 에서 .msg / .bubble / .msg-editor / .msg-actions 등으로 제어
// - 부모가 넘겨준 콜백으로만 동작 (상태는 ChatBot.js가 소유)
// ---------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from "react";

export default function Message({
  id,
  role = "user",          // 'user' | 'assistant'
  text = "",
  editingId = null,       // 현재 편집중인 메시지 id (부모가 관리)
  onStartEdit,            // (id) => void
  onCancelEdit,           // () => void
  onSaveEdit,             // (id, newText) => void
}) {
  const isUser = role === "user";
  const isEditing = editingId === id;
  const [draft, setDraft] = useState(text);
  const taRef = useRef(null);

  // 편집 시작 시 커서 끝으로 이동 + 초점
  useEffect(() => {
    if (isEditing) {
      setDraft(text);
      // textarea mount 후 포커스
      requestAnimationFrame(() => {
        if (taRef.current) {
          taRef.current.focus();
          taRef.current.selectionStart = taRef.current.value.length;
          taRef.current.selectionEnd = taRef.current.value.length;
        }
      });
    }
  }, [isEditing, text]);

  const handleSave = () => {
    const t = String(draft || "").trim();
    if (!t) return;                 // 공백 저장 방지
    onSaveEdit?.(id, t);
  };

  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${isEditing ? "editing" : ""}`}>
      {/* 보기 모드 */}
      {!isEditing ? (
        <>
          <div className="bubble">{text}</div>
          <div className="meta">
            {/* 사용자 메시지만 편집 가능 */}
            {isUser && (
              <button
                className="icon"
                onClick={() => onStartEdit?.(id)}
                title="이 메시지 편집"
              >
                ✏️
              </button>
            )}
          </div>
        </>
      ) : (
        // 편집 모드
        <div className="msg-editor">
          <textarea
            ref={taRef}
            value={draft}
            rows={Math.min(12, Math.max(3, draft.split("\n").length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancelEdit?.();
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                handleSave();
              }
            }}
            placeholder="메시지 수정..."
          />
          <div className="msg-actions">
            <button onClick={() => onCancelEdit?.()}>취소</button>
            <button className="primary" onClick={handleSave}>저장</button>
          </div>
        </div>
      )}
    </div>
  );
}
