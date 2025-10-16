// src/components/EmotionGraphPage.js
// 날짜/월별 감정 분포 라인 그래프 (Chart.js + react-chartjs-2)
// 표준 소스: /api/emotions(유효 데이터 있을 때 채택)
// 폴백: /api/calendar → /messages(제한 병렬)
// 성능: 메모리 캐시 + 차트 애니메이션 OFF
// 디버그 로그는 토글(DEBUG)로 제어

import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Title,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Title,
);

// ───────── 날짜 유틸(KST 고정) ─────────
function ymdKST(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
function daysAgoKST(n) {
  const now = new Date();
  return ymdKST(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
}
function toFirstOfMonth(dateKeyOrDate) {
  const d = dateKeyOrDate instanceof Date ? dateKeyOrDate : new Date(dateKeyOrDate);
  return ymdKST(new Date(d.getFullYear(), d.getMonth(), 1));
}
function monthRangeOf(dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  const from = ymdKST(new Date(y, m - 1, 1));
  const to = ymdKST(new Date(y, m, 0));
  return { from, to, year: y, month: m };
}
function isDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function enumerateDateKeys(from, to) {
  const out = [];
  const df = new Date(from);
  const dt = new Date(to);
  for (let d = new Date(df.getFullYear(), df.getMonth(), df.getDate()); d <= dt; d.setDate(d.getDate() + 1)) {
    out.push(ymdKST(d));
  }
  return out;
}

// ───────── 정규화 공통 ─────────
function pickCounts(v) {
  return v?.counts || v?.moodCounts || v?.moodCounters || null;
}
function pickEmos(v) {
  return v?.emotions || v?.moodLabels || v?.labels || v?.list || null;
}
function unwrap(payload) {
  if (payload && typeof payload === 'object') {
    if (payload.byDate && typeof payload.byDate === 'object') return payload.byDate;
    if (payload.data && (Array.isArray(payload.data) || typeof payload.data === 'object')) return payload.data;
  }
  return payload;
}
function normalizeResponse(payload) {
  const body = unwrap(payload);
  const out = [];

  if (Array.isArray(body)) {
    for (const r of body) {
      const dateKey = r?.dateKey || r?.date || r?.id || (typeof r?.key === 'string' ? r.key : '');
      if (!isDateKey(dateKey)) continue;
      const counts = pickCounts(r);
      const emotions = Array.isArray(pickEmos(r)) ? pickEmos(r).filter(Boolean) : null;
      if (counts && typeof counts === 'object') out.push({ dateKey, counts });
      else out.push({ dateKey, emotions: emotions || [] });
    }
    return out;
  }

  if (body && typeof body === 'object') {
    for (const [dateKey, v] of Object.entries(body)) {
      if (!isDateKey(dateKey)) continue;
      const counts = pickCounts(v);
      const emotions = Array.isArray(pickEmos(v)) ? pickEmos(v).filter(Boolean) : null;
      if (counts && typeof counts === 'object') out.push({ dateKey, counts });
      else out.push({ dateKey, emotions: emotions || [] });
    }
    return out;
  }
  return [];
}

// ───────── 폴백 1: /calendar 요약 ─────────
async function fallbackFromCalendar(finalFrom, finalTo) {
  try {
    const res = await api.get('/calendar', { params: { startDateKey: finalFrom, endDateKey: finalTo } });
    const payload = res?.data?.data ?? res?.data;
    const out = [];

    if (Array.isArray(payload)) {
      for (const r of payload) {
        const dateKey = r?.dateKey || r?.date || r?.id || '';
        if (!isDateKey(dateKey)) continue;
        const counts = pickCounts(r);
        if (counts && typeof counts === 'object') out.push({ dateKey, counts });
      }
      return out;
    }
    if (payload && typeof payload === 'object') {
      for (const [dateKey, v] of Object.entries(payload)) {
        if (!isDateKey(dateKey)) continue;
        const counts = pickCounts(v);
        if (counts && typeof counts === 'object') out.push({ dateKey, counts });
      }
      return out;
    }
    return [];
  } catch {
    return [];
  }
}

// ───────── 폴백 2(최후): /messages 직접 집계(동시 4개 제한) ─────────
function pLimit(limit = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((v) => { active--; resolve(v); next(); })
      .catch((e) => { active--; reject(e); next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
async function fallbackFromMessages(finalFrom, finalTo) {
  try {
    const days = enumerateDateKeys(finalFrom, finalTo);
    const limiter = pLimit(4);
    const jobs = days.map((dateKey) =>
      limiter(async () => {
        const convRes = await api.get('/conversations', { params: { sessionId: dateKey } });
        const convs = convRes?.data?.data || [];
        const counts = {};
        await Promise.all(
          convs.map(async (c) => {
            const mRes = await api.get(`/conversations/${c.id}/messages`, { params: { sessionId: dateKey, limit: 1000 } });
            const msgs = mRes?.data?.data || [];
            for (const m of msgs) {
              const snap = m?.analysisSnapshot_v1 || {};
              const llmOut = snap?.llm?.output || {};
              const emos = Array.isArray(snap.emotions)
                ? snap.emotions
                : Array.isArray(llmOut['감정'])
                  ? llmOut['감정']
                  : [];
              emos.forEach((e) => {
                if (!e) return;
                counts[e] = (counts[e] || 0) + 1;
              });
            }
          })
        );
        return { dateKey, counts };
      })
    );
    const results = await Promise.all(jobs);
    return results;
  } catch {
    return [];
  }
}

// 날짜 전체가 비었는지 → 비면 선을 끊기(null)
const hasAnyCount = (obj) => obj && Object.values(obj).some(v => (Number(v) || 0) > 0);

// ───────── 간단 메모리 캐시 ─────────
const RANGE_CACHE = new Map(); // key: `${from}|${to}` -> [{dateKey,counts}]

// 디버그 토글
const DEBUG = false;

export default function EmotionGraphPage() {
  // 보기 모드
  const [mode, setMode] = useState('month'); // 'month' | 'range'
  const [pivot, setPivot] = useState(toFirstOfMonth(new Date()));
  const { from: mFrom, to: mTo, year, month } = useMemo(() => monthRangeOf(pivot), [pivot]);

  // 기간 모드
  const [from, setFrom] = useState(daysAgoKST(6));
  const [to, setTo] = useState(daysAgoKST(0));

  // 현재 사용자 uid
  const [uid, setUid] = useState(null);

  // 실제 쿼리 범위
  const finalFrom = mode === 'month' ? mFrom : from;
  const finalTo = mode === 'month' ? mTo : to;
  const cacheKey = useMemo(
    () => `${uid || 'anon'}|${finalFrom}|${finalTo}`,
    [uid, finalFrom, finalTo]
  );

  // 상태
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [authed, setAuthed] = useState(false);

  // 중복 요청 취소용
  const abortRef = useRef(null);

  // 로그인 확인
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthed(!!u);
      setUid(u?.uid || null);
      if (!u) {        // 로그아웃됨
        RANGE_CACHE.clear();
        abortRef.current?.abort?.();
        setRows([]);
      }
      setErr(u ? '' : '로그인이 필요합니다.');
    });
    return () => unsub();
  }, []);

  // ───────── 메인 로드 ─────────
  const load = async () => {
    if (!authed) return;

    // 캐시 히트 시 즉시 반영
    if (RANGE_CACHE.has(cacheKey)) {
      setRows(RANGE_CACHE.get(cacheKey));
      return;
    }

    // 이전 요청 취소
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setLoading(true);
      setErr('');

      // 쿼리 파라미터에 signal 넣지 말 것!
      const params = {
        from: finalFrom, to: finalTo,
        startDateKey: finalFrom, endDateKey: finalTo,
      };

      let norm = [];

      // 1) 표준: /emotions
      try {
        const res = await api.get('/emotions', { params, signal: controller.signal });
        const payload = res?.data;
        const n = normalizeResponse(payload);
        if (n.length && hasAnyRowSignal(n)) {
          norm = n;
        }
      } catch { }

      // 2) 폴백: /calendar
      if (!norm.length) {
        const n = await fallbackFromCalendar(finalFrom, finalTo);
        if (n.length && hasAnyRowSignal(n)) {
          norm = n;
        }
      }

      // 3) 최후 폴백: /messages (제한 병렬)
      if (!norm.length) {
        const n = await fallbackFromMessages(finalFrom, finalTo);
        if (n.length && hasAnyRowSignal(n)) {
          norm = n;
        }
      }

      // 날짜축 보정: 기간 내 모든 날짜 채우기
      const axis = enumerateDateKeys(finalFrom, finalTo);
      const byDate = new Map(norm.map(r => [r.dateKey, r]));
      const completed = axis.map(dk => {
        const r = byDate.get(dk);
        if (!r) return { dateKey: dk, counts: {} };
        if (r.counts && typeof r.counts === 'object') return r;
        const counts = {};
        (r.emotions || []).forEach(e => { if (e) counts[e] = (counts[e] || 0) + 1; });
        return { dateKey: dk, counts };
      });

      if (DEBUG) {
        console.log('[EmotionGraph] completed(rows) →', completed);
      }

      RANGE_CACHE.set(cacheKey, completed);
      setRows(completed);
    } catch (e) {
      if (e?.name !== 'CanceledError' && e?.message !== 'canceled') {
        setErr(e?.response?.data?.error || e.message || '그래프 로드 오류');
        setRows([]);
      }
    } finally {
      setLoading(false);
    }
  };

  function hasAnyRowSignal(normRows) {
    for (const r of normRows) {
      if (r?.counts && hasAnyCount(r.counts)) return true;
      if (Array.isArray(r?.emotions) && r.emotions.length) return true;
    }
    return false;
  }

  // 모드/범위/로그인 변경 시 재로드
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalFrom, finalTo, authed, uid]);

  // ───────── rows -> 집계/차트 데이터 ─────────
  const { dates, uniqueEmotions, byDate } = useMemo(() => {
    const dateSet = new Set();
    const totalByEmotion = new Map();
    const map = new Map();

    for (const r of rows) {
      const key = r?.dateKey;
      if (!isDateKey(key)) continue;
      dateSet.add(key);

      const counts = map.get(key) || {};
      const src = r?.counts && typeof r.counts === 'object' ? r.counts : {};

      for (const [emo, n] of Object.entries(src)) {
        if (!emo) continue;
        const val = Number(n) || 0;
        if (val <= 0) continue;
        counts[emo] = (counts[emo] || 0) + val;
        totalByEmotion.set(emo, (totalByEmotion.get(emo) || 0) + val);
      }
      map.set(key, counts);
    }

    const sortedDates = Array.from(dateSet).sort();
    const emos = Array.from(totalByEmotion.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);

    return { dates: sortedDates, uniqueEmotions: emos, byDate: map };
  }, [rows]);

  // ───────── Chart.js 데이터셋 ─────────
  const data = useMemo(() => {
    const datasets = uniqueEmotions.map((emo, idx) => {
      const color = `hsl(${(idx * 57) % 360} 70% 50%)`;
      const arr = dates.map((d) => {
        const bucket = byDate.get(d) || {};
        if (!hasAnyCount(bucket)) return null; // 선 끊기
        return bucket?.[emo] || 0;             // 0은 선 유지
      });
      return {
        label: emo,
        data: arr,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.3,
        spanGaps: true,
      };
    });
    return { labels: dates, datasets };
  }, [dates, uniqueEmotions, byDate]);

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: true,     
      spanGaps: false,
      plugins: {
        title: {
          display: true,
          text:
            mode === 'month'
              ? `날짜별 감정 분포 (건수) • ${year}년 ${month}월`
              : '날짜별 감정 분포 (건수)',
          font: { size: 16, weight: 'bold' },
          color: '#3e3a36',
        },
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 12,
            color: '#3e3a36',
            usePointStyle: true,
            pointStyle: 'line',
          },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.formattedValue}` },
        },
      },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: '#3e3a36' }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: {
          beginAtZero: true,
          ticks: { precision: 0, color: '#3e3a36' },
          grid: { color: 'rgba(0,0,0,0.08)' },
          title: { display: true, text: '건수' },
        },
      },
    }),
    [mode, year, month],
  );

  // 월 이동
  const goPrevMonth = () => {
    const d = new Date(pivot);
    setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() - 1, 1)));
  };
  const goNextMonth = () => {
    const d = new Date(pivot);
    setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() + 1, 1)));
  };

  // 디버그 전역 노출(토글)
  useEffect(() => {
    if (DEBUG) window.__emo = { rows, dates, uniqueEmotions };
  }, [rows, dates, uniqueEmotions]);

  return (
    <div className="page" style={{ width: '100%', display: 'block' }}>
      <div className="toolbar">
        <div className="title">최근 감정 그래프</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            className={`btn ${mode === 'month' ? 'primary' : ''}`}
            onClick={() => setMode('month')}
            aria-pressed={mode === 'month'}
          >
            월별
          </button>
          <button
            className={`btn ${mode === 'range' ? 'primary' : ''}`}
            onClick={() => setMode('range')}
            aria-pressed={mode === 'range'}
          >
            기간
          </button>
        </div>
      </div>

      {mode === 'month' ? (
        <div style={{ margin: '12px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={goPrevMonth} aria-label="이전달">◀</button>
          <div style={{ fontWeight: 600 }}>{year}년 {month}월</div>
          <button className="btn" onClick={goNextMonth} aria-label="다음달">▶</button>
          <button className="btn" onClick={load} disabled={loading || !authed}>
            {loading ? '불러오는 중…' : '새로고침'}
          </button>
          {err && <span style={{ color: 'crimson' }}>그래프 오류: {String(err)}</span>}
          {!authed && <span className="muted">로그인 후 확인하세요.</span>}
        </div>
      ) : (
        <div style={{ margin: '12px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          <button className="btn" onClick={load} disabled={loading || !authed}>
            {loading ? '불러오는 중…' : '새로고침'}
          </button>
          {err && <span style={{ color: 'crimson' }}>그래프 오류: {String(err)}</span>}
          {!authed && <span className="muted">로그인 후 확인하세요.</span>}
        </div>
      )}

      <div style={{ width: '100%', height: 420 }}>
        {dates.length === 0 ? (
          <div
            style={{
              height: '100%',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--muted)',
              border: '1px solid var(--line)',
              borderRadius: '12px',
              background: '#fff',
              textAlign: 'center',
              whiteSpace: 'pre-line',
              padding: 16,
            }}
          >
            {loading
              ? '데이터를 불러오는 중입니다…'
              : '표시할 데이터가 없습니다.\n(해당 기간에 분석된 감정이 없을 수 있어요.)'}
          </div>
        ) : (
          <Line data={data} options={options} />
        )}
      </div>
    </div>
  );
}
