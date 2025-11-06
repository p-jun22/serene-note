// src/components/Container.js
// 달력 프리젠테이션 전용
// - 셀 클릭 시 onSelect(YYYY-MM-DD) 호출.

import React, { useMemo } from "react";

// YYYY-MM-DD (KST)
function ymdKST(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// marks에서 이모지 추출(여러 케이스 허용)
function pickEmoji(cell) {
  if (!cell) return null;
  const s = cell.summary || {};
  return cell.emoji || cell.moodEmoji || s.emoji || s.topEmoji || s.lastEmoji || null;
}

// marks에서 카운트 추출(여러 케이스 허용)
function pickCount(cell) {
  if (!cell) return 0;
  const s = cell.summary || {};
  if (typeof cell.count === "number") return cell.count;
  if (typeof cell.messagesCount === "number") return cell.messagesCount;
  if (typeof s.count === "number") return s.count;
  if (cell.convSet && typeof cell.convSet === "object") return Object.keys(cell.convSet).length;
  return 0;
}

export default function Container({ year, month, marks = {}, onSelect }) {
  const safeYear = Number.isInteger(year) ? year : new Date().getFullYear();
  const safeMonth = Number.isInteger(month) ? month : (new Date().getMonth() + 1);

  const cells = useMemo(() => {
    const first = new Date(safeYear, safeMonth - 1, 1);
    const firstKST = new Date(first.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const startDow = firstKST.getDay(); // 0~6

    const arr = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(firstKST);
      d.setDate(firstKST.getDate() + (i - startDow));
      const dateKey = ymdKST(d);
      const inThisMonth = d.getMonth() === (safeMonth - 1);
      const mark = marks[dateKey] || null;
      arr.push({
        date: d,
        dateKey,
        inThisMonth,
        emoji: pickEmoji(mark),
        count: pickCount(mark),
      });
    }
    return arr;
  }, [safeYear, safeMonth, marks]);

  return (
    <div className="calendar">
      {/* 요일 헤더 */}
      <div className="weekdays">
        {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>

      {/* 날짜 그리드 */}
      <div className="days">
        {cells.map(({ date, dateKey, inThisMonth, emoji, count }) => (
          <button
            key={dateKey}
            type="button"
            className={`cell ${inThisMonth ? "" : "muted"}`}
            onClick={() => { if (typeof onSelect === "function") onSelect(dateKey); }}
            title={`${dateKey}${count ? ` · ${count}개` : ""}`}
            aria-label={`${dateKey}${count ? `, ${count}개` : ""}`}
          >
            {/* 이모지/카운트 표시 (App.css에 이미 스타일 존재) */}
            {emoji ? <span className="mood" aria-hidden="true">{emoji}</span> : null}
            {count > 0 ? <span className="badge" aria-hidden="true">{count}</span> : null}
            <span className="num" aria-hidden="true">{date.getDate()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
