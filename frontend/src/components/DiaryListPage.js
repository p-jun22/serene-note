// src/components/DiaryListPage.js
// 월간 아카이브 + '일별로 묶어, 각 대화에서 사용자의 첫 인풋만' 보기
// - 제목을 함께 보여주고(대화 ID 대신), 인라인 제목 수정까지 지원

import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';

function ymdKST(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
function toFirstOfMonth(dateKeyOrDate) {
  const d = dateKeyOrDate instanceof Date ? dateKeyOrDate : new Date(dateKeyOrDate);
  return ymdKST(new Date(d.getFullYear(), d.getMonth(), 1));
}
function monthRangeOf(dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  const first = ymdKST(new Date(y, m - 1, 1));
  const last = ymdKST(new Date(y, m, 0));
  return { from: first, to: last, year: y, month: m };
}

export default function DiaryListPage({ focusDate, onBack }) {
  // 월 피벗
  const [pivot, setPivot] = useState(toFirstOfMonth(focusDate || new Date()));
  const { from, to, year, month } = useMemo(() => monthRangeOf(pivot), [pivot]);

  // 캘린더 마크(해당 월의 작성 여부/이모지/대화 수)
  const [marks, setMarks] = useState({}); // { dateKey: { count, topEmoji } }
  const [loading, setLoading] = useState(true);

  // 일자별 상세(첫 사용자 인풋 리스트 + title 병합)
  // details[dateKey] = [{conversationId, title, firstUserText, firstUserAt, firstMessageId}]
  const [dayDetails, setDayDetails] = useState({});
  const [openKeys, setOpenKeys] = useState({});
  const anchorsRef = useRef({});

  // 월간 캘린더 마크 로드
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await api.get('/calendar', { params: { startDateKey: from, endDateKey: to } });
        const data = res?.data?.data ?? {};
        setMarks(data);
      } catch (e) {
        console.error(e);
        setMarks({});
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to]);

  // 정렬된 날짜 목록
  const sortedDates = useMemo(() => Object.keys(marks).sort(), [marks]);

  // 처음 focusDate가 있으면 펼치고 스크롤
  useEffect(() => {
    if (!focusDate || !marks[focusDate]) return;
    setOpenKeys((prev) => ({ ...prev, [focusDate]: true }));
    setTimeout(() => anchorsRef.current[focusDate]?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }), 120);
  }, [focusDate, marks]);

  // 안전한 텍스트 변환기 (undefined -> '', 객체 -> JSON)
  const coerceText = (x) => {
    if (typeof x === 'string') return x;
    if (x == null) return '';
    try { return JSON.stringify(x); } catch { return String(x); }
  };

  // 특정 날짜의 대화 제목들 가져오기: {id -> title}
  async function fetchTitlesMap(dateKey) {
    try {
      const res = await api.get('/conversations', { params: { sessionId: dateKey } });
      const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
      const map = {};
      rows.forEach((r) => { map[r.id] = r.title || ''; });
      return map;
    } catch (e) {
      console.warn('fetchTitlesMap failed', e);
      return {};
    }
  }

  // 일자 섹션 토글 시: "펼칠 때마다" 항상 서버에서 다시 가져온다
  const toggleDate = async (dateKey) => {
    const nextOpen = !openKeys[dateKey];
    setOpenKeys((p) => ({ ...p, [dateKey]: nextOpen }));

    if (!nextOpen) return; // 닫을 때는 아무것도 안 함

    // 로딩 상태 표시: 의도적으로 undefined를 넣는다.
    setDayDetails((p) => ({ ...p, [dateKey]: undefined }));

    try {
      // ① 첫 사용자 인풋 목록
      const res = await api.get(`/days/${dateKey}/first-user-inputs`);
      const raw = res?.data?.data;

      let arr;
      if (Array.isArray(raw)) arr = raw;
      else if (raw && Array.isArray(raw.rows)) arr = raw.rows;
      else if (raw && typeof raw === 'object') {
        // { convId: {...}, ... } 형태
        arr = Object.entries(raw).map(([conversationId, v]) => ({ conversationId, ...(v || {}) }));
      } else arr = [];

      const normalized = arr
        .map((x, i) => {
          const conversationId = String(x.conversationId || x.id || `conv_${i}`);
          const firstUserText = coerceText(
            x.firstUserText ?? x.text ?? x.first_text ?? x.first ?? x.userText ?? ''
          );
          const firstUserAt = x.firstUserAt ?? x.createdAt ?? x.created_at ?? null;
          const firstMessageId = String(x.firstMessageId ?? x.messageId ?? x.mid ?? '');
          return { conversationId, firstUserText, firstUserAt, firstMessageId };
        })
        .filter((r) => (r.firstUserText || '').trim().length > 0);

      // ② 같은 날짜의 모든 대화 → 제목 맵
      const titleMap = await fetchTitlesMap(dateKey);

      // ③ 병합: 제목 붙이기
      const merged = normalized.map((r) => ({
        ...r,
        title: (titleMap[r.conversationId] || '').trim(),
      }));

      setDayDetails((p) => ({ ...p, [dateKey]: merged }));
    } catch (e) {
      console.error('first-user-inputs fetch error', e);
      setDayDetails((p) => ({ ...p, [dateKey]: [] }));
    }
  };

  // 제목 수정 (인라인)
  const handleRename = async (dateKey, conversationId, currentTitle) => {
    const title = window.prompt('새 제목을 입력하세요', currentTitle || '')?.trim();
    if (!title) return;
    try {
      await api.patch(`/conversations/${conversationId}`, { title }, { params: { sessionId: dateKey } });
      // 로컬 상태 반영
      setDayDetails((prev) => {
        const list = prev[dateKey] || [];
        return {
          ...prev,
          [dateKey]: list.map((r) => (r.conversationId === conversationId ? { ...r, title } : r)),
        };
      });
    } catch (e) {
      console.error('rename failed', e?.response?.data || e.message);
      alert('제목 수정 실패');
    }
  };

  // 월 전환
  const goPrevMonth = () => {
    const d = new Date(pivot);
    setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() - 1, 1)));
  };
  const goNextMonth = () => {
    const d = new Date(pivot);
    setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() + 1, 1)));
  };

  return (
    <div className="page page-diary-archive">
      <div className="archive-container">
        <div className="archive-header">
          <h2 className="title">📅 {year}년 {month}월 기록 아카이브</h2>
          <div style={{ display:'flex', gap:8, marginLeft:'auto' }}>
            <button className="btn" onClick={goPrevMonth} aria-label="이전달">◀</button>
            <button className="btn" onClick={goNextMonth} aria-label="다음달">▶</button>
            {onBack && <button className="btn back" onClick={onBack}>뒤로</button>}
          </div>
        </div>

        {loading ? (
          <div className="muted center">불러오는 중…</div>
        ) : sortedDates.length === 0 ? (
          <div className="panel muted center">이 달에는 기록이 없습니다.</div>
        ) : (
          <div className="archive-grid">
            {sortedDates.map((dateKey) => {
              const mark = marks[dateKey] || {};
              const open = !!openKeys[dateKey];
              const details = dayDetails[dateKey];

              return (
                <section
                  key={dateKey}
                  className={`archive-card ${open ? 'open' : ''}`}
                  ref={(el) => (anchorsRef.current[dateKey] = el)}
                >
                  <button
                    className="card-head"
                    onClick={() => toggleDate(dateKey)}
                    aria-expanded={open}
                    aria-controls={`day-body-${dateKey}`}
                  >
                    <div className="left">
                      <span className="emoji" aria-hidden>{mark.topEmoji || '📝'}</span>
                      <span className="date">{dateKey}</span>
                    </div>
                    <div className="right">
                      <span className="badge">대화 {mark.count || 0}개</span>
                      <span className={`caret ${open ? 'up' : 'down'}`} />
                    </div>
                  </button>

                  {open && (
                    <div id={`day-body-${dateKey}`} className="card-body">
                      {details === undefined ? (
                        <div className="muted">불러오는 중…</div>
                      ) : Array.isArray(details) && details.length === 0 ? (
                        <div className="muted">이 날에는 첫 사용자 인풋이 없습니다.</div>
                      ) : (
                        <ul
                          style={{
                            margin: 0,
                            padding: 0,
                            listStyle: 'none',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                          }}
                        >
                          {details.map((row) => (
                            <li
                              key={row.conversationId}
                              style={{
                                border: '1px solid var(--line)',
                                borderRadius: 12,
                                background: '#fff',
                                padding: '10px 12px',
                              }}
                            >
                              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                                <div style={{ fontWeight:600 }}>
                                  {row.title?.trim() ? row.title.trim() : '(제목 없음)'}
                                </div>
                                <button
                                  className="icon-btn"
                                  title="제목 수정"
                                  onClick={() => handleRename(dateKey, row.conversationId, row.title)}
                                  aria-label="제목 수정"
                                  style={{ fontSize: '0.9rem' }}
                                >
                                  ✏️
                                </button>
                                <div style={{ marginLeft:'auto', color:'#8b857f', fontSize:'.8rem' }}>
                                  {/* 보조로 id를 아주 희미하게 표기 */}
                                  #{row.conversationId}
                                </div>
                              </div>
                              <div style={{ whiteSpace: 'pre-wrap' }}>
                                {row.firstUserText || '(빈 입력)'}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
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
