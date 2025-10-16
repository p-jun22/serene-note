// src/components/Message.js
// 단일 메시지 렌더 + 인라인 편집 + (NEW) 피드백 UX(전송중/완료/자동숨김)

import React, { useEffect, useRef, useState } from "react";

export default function Message({
  id,
  role = "user",
  text = "",
  editingId = null,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  isAdmin = false,
  onRate,                     // (id, score) => Promise<boolean>
  // NEW: 필요 시 상위가 강제로 숨길 수 있게 (null이면 자동판정)
  forceHideFeedback = null,   // true | false | null
  // NEW: 모드 힌트(주면 정확하게 동작). 'admin' | 'user' | 'baseline'
  mode = undefined,
}) {
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const isEditing = editingId === id;

  const [draft, setDraft] = useState(text);
  const taRef = useRef(null);

  // NEW: 피드백 전송 상태
  const [sendingRate, setSendingRate] = useState(false);
  const [ratedScore, setRatedScore] = useState(null); // number|null
  const [hideBar, setHideBar] = useState(false);

  useEffect(() => {
    if (isEditing) {
      setDraft(text);
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
    if (!t) return;
    onSaveEdit?.(id, t);
  };

  // NEW: 피드백 클릭 → 전송중 표시 → 성공 시 감사표시 후 자동 숨김
  const handleRateClick = async (score) => {
    if (sendingRate || ratedScore != null) return;
    try {
      setSendingRate(true);
      const ok = await onRate?.(id, score);
      if (ok !== false) {
        setRatedScore(score);
        // 1.2초 뒤 자동 숨김
        setTimeout(() => setHideBar(true), 1200);
      }
    } catch (e) {
      // 실패하면 다시 누를 수 있게 복구
      console.error(e);
      alert("피드백 전송에 실패했습니다.");
    } finally {
      setSendingRate(false);
    }
  };
  // ─────────────────────────────────────────────
  // 피드백 바 노출 규칙
  // 1) admin → 항상 노출
  // 2) baseline/basic → 항상 숨김
  // 3) 안전(위기) 안내 메시지 → 일반 유저에서는 숨김
  // 4) 상위가 forceHideFeedback 지정 시 그 값을 따름
  // ─────────────────────────────────────────────
  const inferLooksLikeSafety = (() => {
    const t = String(text || "");
    // 안전 고지 주요 키워드(한국 상담번호/안전 문구)
    const hints = [
      /이 앱은 당신의 안전/,
      /가까운 보호자|친구|상담센터에 즉시 연락/,
      /1393|129|1388|1577-0199|1644-0070|보건복지상담/,
    ];
    // 안전 메시지는 우리가 의도적으로 날짜 프리픽스([YYYY-MM-DD])를 제거함
    const noDatePrefix = !/^\[\d{4}-\d{2}-\d{2}\]/.test(t);
    const hasHint = hints.some((re) => re.test(t));
    // 글머리표 기반 포맷(• …)이 여러 줄이면 안전문구일 확률 ↑
    const bullets = (t.match(/^\s*•/gm) || []).length;
    return (noDatePrefix && (hasHint || bullets >= 2));
  })();

  const isBaselineMode = (mode === "baseline"); // 상위가 넘겨주면 확실
  // 상위에서 강제 지정했으면 그 값을 따르고, 아니면 규칙으로 판정
  const shouldHideByRule =
    isAdmin
      ? false
      : (isBaselineMode || inferLooksLikeSafety);

  const hideFeedback =
    forceHideFeedback === null ? shouldHideByRule : !!forceHideFeedback;

  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${isEditing ? "editing" : ""}`}>
      {!isEditing ? (
        <>
          <div className="bubble">{text}</div>

           {isAssistant && !hideBar && !hideFeedback && (
            <div className="feedback-bar" aria-live="polite">
              {ratedScore == null ? (
                isAdmin ? (
                  <>
                    <button
                      className="fb-btn neg"
                      title="부적절/틀림(0)"
                      disabled={sendingRate}
                      aria-pressed="false"
                      onClick={() => handleRateClick(0)}
                    >
                      {sendingRate ? "보내는 중..." : "👎 0"}
                    </button>
                    <button
                      className="fb-btn pos"
                      title="적절/맞음(1)"
                      disabled={sendingRate}
                      aria-pressed="false"
                      onClick={() => handleRateClick(1)}
                    >
                      {sendingRate ? "보내는 중..." : "👍 1"}
                    </button>
                  </>
                ) : (
                  <div className="fb-steps">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        className="fb-btn step"
                        title={`만족도 ${n}`}
                        disabled={sendingRate}
                        aria-pressed={false}
                        onClick={() => handleRateClick(n)}
                      >
                        {sendingRate ? "…" : n}
                      </button>
                    ))}
                  </div>
                )
              ) : (
                // 완료 메시지 (인라인 스타일만 사용, CSS 영향 최소화)
                <div style={{ fontSize: ".9rem", color: "#6b6b6b", padding: "2px 4px" }}>
                  감사합니다! (평점 {ratedScore})
                </div>
              )}
            </div>
          )}

          <div className="meta">
            {isUser && (
              <button className="icon" onClick={() => onStartEdit?.(id)} title="이 메시지 편집">
                ✏️
              </button>
            )}
          </div>
        </>
      ) : (
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
