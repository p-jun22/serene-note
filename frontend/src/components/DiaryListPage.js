// src/components/DiaryArchivePage.js
import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';

function ymdKST(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function monthRangeOf(dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  const first = ymdKST(new Date(y, m - 1, 1));
  const last = ymdKST(new Date(y, m, 0));
  return { from: first, to: last, year: y, month: m };
}

function countByEmotion(arr) {
  const map = {};
  (arr || []).forEach((e) => {
    if (!e) return;
    map[e] = (map[e] || 0) + 1;
  });
  return map;
}

function topEmojiFromCounts(countMap) {
  const EMOJI = {
    행복: '😊', 기쁨: '😊', 즐거움: '😊', 만족: '🙂',
    사랑: '🥰', 설렘: '🤩', 기대: '🤩',
    평온: '😌', 안정: '😌', 중립: '😐',
    불안: '😟', 걱정: '😟', 초조: '😟', 두려움: '😨', 공포: '😨',
    슬픔: '😢', 우울: '😞', 상실: '😢',
    분노: '😠', 짜증: '😠', 화: '😠',
    수치심: '😳', 부끄러움: '😳',
    피곤: '🥱', 지침: '🥱',
  };
  const entries = Object.entries(countMap).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '📝';
  const [emo] = entries[0];
  return EMOJI[emo] || '📝';
}

export default function DiaryArchivePage({ focusDate, onBack }) {
  const { from, to, year, month } = useMemo(() => {
    const target = focusDate || ymdKST(new Date());
    return monthRangeOf(target);
  }, [focusDate]);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openKeys, setOpenKeys] = useState({});
  const anchorsRef = useRef({}); // dateKey -> ref

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await api.get('/emotions', { params: { from, to } });
        setRows(Array.isArray(res.data?.data) ? res.data.data : []);
      } catch (e) {
        console.error(e);
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to]);

  const grouped = useMemo(() => {
    const map = new Map(); // dateKey -> emotions[]
    for (const r of rows) {
      const dateKey = r?.dateKey;
      if (!dateKey) continue;
      const arr = map.get(dateKey) || [];
      arr.push(...(Array.isArray(r.emotions) ? r.emotions : []));
      map.set(dateKey, arr);
    }
    return map;
  }, [rows]);

  const sortedDates = useMemo(() => Array.from(grouped.keys()).sort(), [grouped]);

  useEffect(() => {
    if (!focusDate || !grouped.has(focusDate)) return;
    setOpenKeys((prev) => ({ ...prev, [focusDate]: true }));
    const el = anchorsRef.current[focusDate];
    if (el && el.scrollIntoView) {
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
    }
  }, [focusDate, grouped]);

  const totalCount = (arr) => Object.values(countByEmotion(arr)).reduce((a, b) => a + b, 0);

  return (
    <div className="page page-diary-archive">
      <div className="archive-container">
        <div className="archive-header">
          <h2 className="title">📅 {year}년 {month}월 기록 아카이브</h2>
          <button className="btn back" onClick={onBack}>뒤로</button>
        </div>

        {loading ? (
          <div className="muted center">불러오는 중…</div>
        ) : sortedDates.length === 0 ? (
          <div className="panel muted center">이 달에는 기록이 없습니다.</div>
        ) : (
          <div className="archive-grid">
            {sortedDates.map((dateKey) => {
              const emotions = grouped.get(dateKey) || [];
              const counts = countByEmotion(emotions);
              const emoji = topEmojiFromCounts(counts);
              const sum = totalCount(emotions);
              const open = !!openKeys[dateKey];

              return (
                <section
                  key={dateKey}
                  className={`archive-card ${open ? 'open' : ''}`}
                  ref={(el) => (anchorsRef.current[dateKey] = el)}
                >
                  <button
                    className="card-head"
                    onClick={() => setOpenKeys((p) => ({ ...p, [dateKey]: !p[dateKey] }))}
                    aria-expanded={open}
                  >
                    <div className="left">
                      <span className="emoji">{emoji}</span>
                      <span className="date">{dateKey}</span>
                    </div>
                    <div className="right">
                      <span className="badge">총 {sum}건</span>
                      <span className={`caret ${open ? 'up' : 'down'}`} />
                    </div>
                  </button>

                  {open && (
                    <div className="card-body">
                      <div className="chip-row">
                        {Object.entries(counts)
                          .sort((a, b) => b[1] - a[1])
                          .map(([emo, n]) => (
                            <span key={emo} className="chip">
                              {emo} <b>{n}</b>
                            </span>
                          ))}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
