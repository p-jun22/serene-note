// src/components/CalendarPage.js
// - 날짜 클릭 시 즉시 onWrite(dateKey) 호출(모달/기록보기 없음: 최신 정책).
// - /api/calendar 응답은 { data: { "YYYY-MM-DD": {...} } } 형태를 우선 사용하되
//   일부 구버전/테스트 응답에 대응하기 위해 배열 => 객체 매핑을 보강함.

import React, { useEffect, useMemo, useState } from "react";
import Container from "./Container";
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

// 기준 월의 1일~말일 범위를 KST로 산출
function monthRangeKST(baseDate) {
  const y = baseDate.getFullYear();
  const m = baseDate.getMonth();
  return { start: ymdKST(new Date(y, m, 1)), end: ymdKST(new Date(y, m + 1, 0)) };
}

export default function CalendarPage({ onWrite }) {
  const [current, setCurrent] = useState(() => new Date());
  const [marks, setMarks] = useState({});

  const year = current.getFullYear();
  const month = current.getMonth() + 1;
  const { start, end } = useMemo(() => monthRangeKST(current), [current]);

  const gotoPrev = () => { const d = new Date(current); d.setMonth(d.getMonth() - 1); setCurrent(d); };
  const gotoNext = () => { const d = new Date(current); d.setMonth(d.getMonth() + 1); setCurrent(d); };
  const gotoToday = () => setCurrent(new Date());

  // 현재 월 범위의 캘린더 데이터 로드
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get("/calendar", { params: { startDateKey: start, endDateKey: end } });
        // 우선 최신 스키마 { data: { dateKey: {...} } } 를 쓴다.
        // 혹시 구버전/실험 응답이 배열이면 객체로 변환해 호환한다.
        let data = res?.data?.data || res?.data || {};
        if (Array.isArray(data)) {
          const obj = {};
          for (const row of data) {
            const k = row?.dateKey || row?.date || null;
            if (k) obj[k] = row;
          }
          data = obj;
        }
        if (alive) setMarks(data);
      } catch (e) {
        console.error("/api/calendar error:", e);
        if (alive) setMarks({});
      }
    })();
    return () => { alive = false; };
  }, [start, end]);

  // 날짜 클릭 시: 최신 정책대로 바로 글쓰기(onWrite)로 진입
  const handleSelect = (dateKey) => {
    if (typeof onWrite === "function") onWrite(dateKey);
  };

  return (
    <div className="page page-calendar">
      <div className="calendar-wrap">
        <div className="toolbar">
          <div className="left">
            <button className="btn" onClick={gotoPrev}>◀</button>
            <span className="title">{year} - {String(month).padStart(2, "0")}</span>
          </div>
          <div className="right">
            <button className="btn" onClick={gotoNext}>▶</button>
            <button className="btn" onClick={gotoToday}>이번 달</button>
          </div>
        </div>

        <Container
          year={year}
          month={month}
          marks={marks}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}
