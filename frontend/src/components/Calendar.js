import React from "react";

// YYYY-MM-DD (KST)
function ymdKST(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

/**
 * props:
 * - baseDate: Date (해당 월, 필수)
 * - onPrev?: () => void
 * - onNext?: () => void
 * - onSelect?: (dateKey: string) => void   // ✅ 표준
 * - onPick?: (date: Date) => void          // 과거 호환
 * - marks?: Record<dateKey, { emoji?: string, count?: number }>
 */
export default function Calendar({
  baseDate,
  onPrev,
  onNext,
  onSelect,
  onPick,
  marks = {},
}) {
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startWeekday = (first.getDay() + 6) % 7; // 월=0 기준

  // 6주 그리드
  const cells = [];
  let day = 1 - startWeekday;
  for (let w = 0; w < 6; w++) {
    for (let d = 0; d < 7; d++, day++) {
      const cur = new Date(year, month, day);
      const inMonth = cur.getMonth() === month;
      const key = ymdKST(cur);
      cells.push({ key, cur, inMonth });
    }
  }

  return (
    <div className="calendar">
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <button className="btn" onClick={onPrev} aria-label="이전 달">◀</button>
        <div className="title" style={{ flex: 1, textAlign: "center" }}>
          {year}년 {month + 1}월
        </div>
        <button className="btn" onClick={onNext} aria-label="다음 달">▶</button>
      </div>

      <div className="weekdays">
        {["월", "화", "수", "목", "금", "토", "일"].map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      <div className="days">
        {cells.map(({ key, cur, inMonth }) => {
          const m = marks[key] || {};
          const count = m.count || 0;
          const emoji = m.emoji || "";

          return (
            <button
              key={key}
              className={`cell ${inMonth ? "" : "muted"}`}
              onClick={() => {
                if (!inMonth) return;
                // 과거 호환(onPick) + 현재(onSelect) 모두 호출
                onPick?.(cur);
                onSelect?.(key);
              }}
              title={`${key}${count ? ` · ${count}개` : ""}`}
            >
              {emoji ? <span className="mood" aria-label="mood">{emoji}</span> : null}
              {count > 0 ? <span className="badge">{count}</span> : null}
              <span className="num">{cur.getDate()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
