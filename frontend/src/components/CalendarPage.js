import React, { useEffect, useMemo, useState } from "react";
import Calendar from "./Calendar";
import api from "../api";

// YYYY-MM-DD (KST)
function ymdKST(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function monthRange(dateLike) {
  const d = new Date(dateLike);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: ymdKST(first), end: ymdKST(last) };
}

export default function CalendarPage({ onWrite, onView }) {
  const [baseDate, setBaseDate] = useState(new Date());
  const [choice, setChoice] = useState(null); // { dateKey, exists }
  const [marks, setMarks] = useState({});     // { dateKey: { emoji, count } }
  const [err, setErr] = useState("");

  const { start, end } = useMemo(() => monthRange(baseDate), [baseDate]);

  // 현재 달의 캘린더 마크 로드
  useEffect(() => {
    (async () => {
      try {
        setErr("");
        const res = await api.get("/calendar", {
          params: { startDateKey: start, endDateKey: end },
        });
        // 응답: { "YYYY-MM-DD": { count, topEmoji } }
        const mapped = {};
        Object.entries(res?.data || {}).forEach(([dateKey, v]) => {
          mapped[dateKey] = {
            emoji: v?.topEmoji || "",
            count: typeof v?.count === "number" ? v.count : 0,
          };
        });
        setMarks(mapped);
      } catch (e) {
        setErr(e?.response?.data?.error || e.message || "캘린더 로드 오류");
        setMarks({});
      }
    })();
  }, [start, end]);

  // 날짜 클릭 시
  const handleSelect = async (dateKey) => {
    try {
      if ((marks?.[dateKey]?.count || 0) > 0) {
        setChoice({ dateKey, exists: true });
        return;
      }
      const res = await api.get(`/calendar/${dateKey}`);
      setChoice({ dateKey, exists: !!res.data?.exists });
    } catch {
      setChoice({ dateKey, exists: false });
    }
  };

  return (
    <div className="page page-calendar">
      <h2 className="page-title">캘린더</h2>
      {err && <div style={{ color: "crimson" }}>ERROR: {err}</div>}

      <div className="calendar-wrap">
        <div className="calendar-card">
          <Calendar
            baseDate={baseDate}
            onPrev={() =>
              setBaseDate(new Date(baseDate.getFullYear(), baseDate.getMonth() - 1, 1))
            }
            onNext={() =>
              setBaseDate(new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1))
            }
            // ✅ 클릭 작동: onSelect로 전달 (onPick 아님)
            onSelect={handleSelect}
            // ✅ 날짜별 이모지/개수 표시
            marks={marks}
          />
        </div>
      </div>

      {choice && (
        <>
          <div className="popup-backdrop" onClick={() => setChoice(null)} />
          <div className="choice-modal">
            <div className="panel" style={{ padding: "16px" }}>
              <h3 style={{ marginBottom: 8 }}>{choice.dateKey}</h3>
              <p style={{ marginBottom: 12 }}>
                {choice.exists ? "이미 작성된 기록이 있습니다." : "아직 기록이 없습니다."}
              </p>
              <div className="choice-body">
                <button className="btn" onClick={() => { onView?.(choice.dateKey); setChoice(null); }}>
                  기록 보기
                </button>
                <button className="btn primary" onClick={() => { onWrite?.(choice.dateKey); setChoice(null); }}>
                  일기 쓰기
                </button>
                <button className="btn" onClick={() => setChoice(null)}>닫기</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
