// src/components/EmotionGraphPage.js
// - 날짜/월별 감정 분포 라인 그래프 + 포인트 클릭 시 바이오리듬 모달

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
  BarElement,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Title,
  BarElement,
);

// 상수
const TOP_EMO_K = 8; // 시간대 모달에서 감정 상위 K개(가독성)
const DEBUG = false;

// 날짜 유틸(KST 고정)
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

// 정규화 공통
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

// 폴백 1: /calendar 요약
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

// 폴백 2(최후): /messages 직접 집계(동시 4개 제한)
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
                  : Array.isArray(llmOut.emotions)
                    ? llmOut.emotions
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

const hasAnyCount = (obj) => obj && Object.values(obj).some(v => (Number(v) || 0) > 0);

// 메모리 캐시
const RANGE_CACHE = new Map();  // key: `${uid}|${from}|${to}` => [{dateKey,counts}]
const HOURLY_CACHE = new Map(); // key: `${uid}|${dateKey}` => { hours:[0..23], countsPerHour:[24], byEmotion:{emo:[24]}, topEmos:[...] }

// 시간대 집계 로더
async function loadHourlyForDate(uid, dateKey) {
  // KST 고정 포맷터
  const kstHourFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false
  });

  const cacheKey = `${uid || 'anon'}|${dateKey}`;
  if (HOURLY_CACHE.has(cacheKey)) return HOURLY_CACHE.get(cacheKey);

  // 대화/메시지 로드
  const convRes = await api.get('/conversations', { params: { sessionId: dateKey } });
  const convs = convRes?.data?.data || [];

  // 0~23 초기화
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const countsPerHour = Array.from({ length: 24 }, () => 0);
  const byEmotion = {}; // { emo: [24 counts] }

  // 감정 라벨 뽑기 유틸
  const pullEmos = (m) => {
    const snap = m?.analysisSnapshot_v1 || {};
    const llmOut = snap?.llm?.output || {};
    if (Array.isArray(snap.emotions)) return snap.emotions.filter(Boolean);
    if (Array.isArray(llmOut['감정'])) return llmOut['감정'].filter(Boolean);
    if (Array.isArray(llmOut.emotions)) return llmOut.emotions.filter(Boolean);
    return [];
  };

  for (const c of convs) {
    const mRes = await api.get(`/conversations/${c.id}/messages`, { params: { sessionId: dateKey, limit: 1000 } });
    const msgs = mRes?.data?.data || [];
    for (const m of msgs) {
      if (m.role !== 'user') continue;

      // createdAt => 시(KST)
      let t = null;
      if (m.createdAt?._seconds) t = new Date(m.createdAt._seconds * 1000);
      else if (typeof m.createdAt === 'string') t = new Date(m.createdAt);
      else if (m.createdAt?.toDate) t = m.createdAt.toDate();
      const h = t ? parseInt(kstHourFmt.format(t), 10) : 0;

      countsPerHour[h] += 1;

      const emos = pullEmos(m);
      for (const emo of emos) {
        if (!emo) continue;
        if (!byEmotion[emo]) byEmotion[emo] = Array.from({ length: 24 }, () => 0);
        byEmotion[emo][h] += 1;
      }
    }
  }

  // 상위 감정 K개만 차트에 사용(많으면 가독성↓)
  const topEmos = Object.entries(byEmotion)
    .map(([emo, arr]) => [emo, arr.reduce((a, b) => a + (b || 0), 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.min(TOP_EMO_K, Object.keys(byEmotion).length))
    .map(([emo]) => emo);

  const payload = { hours, countsPerHour, byEmotion, topEmos, dateKey };
  HOURLY_CACHE.set(cacheKey, payload);
  return payload;
}

// 모달 컴포넌트
function HourlyModal({ open, onClose, dateKey, uid }) {
  const [loading, setLoading] = useState(false);
  const [hourly, setHourly] = useState(null);

  // 데이터 로드: open/dateKey 바뀔 때마다(닫히면 메모리 비움)
  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!open || !dateKey) {
        setHourly(null);
        return;
      }
      setLoading(true);
      try {
        const v = await loadHourlyForDate(uid, dateKey);
        if (!cancel) setHourly(v);
      } catch (e) {
        if (!cancel) {
          setHourly({
            hours: [],
            countsPerHour: [],
            byEmotion: {},
            topEmos: [],
            error: e?.message || '로드 실패',
          });
        }
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [open, dateKey, uid]);

  // 훅은 항상 호출 (open 여부와 무관)
  const barData = useMemo(() => {
    const h = hourly?.hours || Array.from({ length: 24 }, (_, i) => i);
    const counts = hourly?.countsPerHour || Array.from({ length: 24 }, () => 0);
    return {
      labels: h.map(v => `${v}h`),
      datasets: [{
        label: '메시지 수',
        data: counts,
        backgroundColor: 'hsla(210, 80%, 55%, 0.8)',
        borderColor: 'hsl(210, 80%, 45%)',
        borderWidth: 1,
      }],
    };
  }, [hourly]);

  const stackedData = useMemo(() => {
    const h = hourly?.hours || Array.from({ length: 24 }, (_, i) => i);
    const emos = hourly?.topEmos || [];
    const datasets = emos.map((emo, idx) => {
      const color = `hsl(${(idx * 62) % 360} 75% 52%)`;
      return {
        label: emo,
        data: (hourly?.byEmotion?.[emo] || Array.from({ length: 24 }, () => 0)),
        backgroundColor: color,
        borderColor: color,
        borderWidth: 1,
      };
    });

    // 무라벨(감정 배열이 없었던 메시지) = 전체 - 감정합
    const totals = hourly?.countsPerHour || Array.from({ length: 24 }, () => 0);
    const sumByHour = h.map((hh) => emos.reduce((s, emo) => s + ((hourly?.byEmotion?.[emo]?.[hh] || 0)), 0));
    const unlabeled = h.map((hh, i) => Math.max(0, totals[hh] - sumByHour[i]));
    datasets.push({
      label: '(무라벨)',
      data: unlabeled,
      backgroundColor: 'hsl(0 0% 80% / 0.9)',
      borderColor: 'hsl(0 0% 65%)',
      borderWidth: 1,
    });

    return { labels: h.map(v => `${v}h`), datasets };
  }, [hourly]);

  // HourlyModal 내부 옵션 공통
  const commonOpts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12 } },
      // 기본 tooltip 설정은 공통으로 두고, 각 차트에서 filter만 오버라이드
      tooltip: { mode: 'index', intersect: false },
      title: { display: false },
    },
    interaction: { mode: 'index', intersect: false },
  };

  // 1 시간대별 메시지 수 (막대) - 0이면 툴팁 숨김
  const barOpts = {
    ...commonOpts,
    plugins: {
      ...commonOpts.plugins,
      tooltip: {
        ...commonOpts.plugins.tooltip,
        filter: (item) => {
          const v = item.parsed?.y ?? item.raw;
          return v != null && !Number.isNaN(v) && v !== 0;
        },
      },
    },
    scales: {
      x: { stacked: false, grid: { color: 'rgba(0,0,0,0.05)' } },
      y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(0,0,0,0.08)' }, title: { display: true, text: '건수' } },
    },
  };

  // 2 시간대별 감정 분포(스택) - 0이면 툴팁 숨김 + 값 있는 항목만 정렬
  const stackedOpts = {
    ...commonOpts,
    plugins: {
      ...commonOpts.plugins,
      tooltip: {
        ...commonOpts.plugins.tooltip,
        filter: (item) => {
          const v = item.parsed?.y ?? item.raw;
          return v != null && !Number.isNaN(v) && v !== 0;
        },
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed?.y ?? ctx.raw;
            if (!v) return null;               // 0/null은 아예 표시 안 함
            return `${ctx.dataset.label}: ${v}`;
          },
          itemSort: (a, b) => (b.parsed?.y ?? 0) - (a.parsed?.y ?? 0),
        },
      },
    },
    scales: {
      x: { stacked: true, grid: { color: 'rgba(0,0,0,0.05)' } },
      y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(0,0,0,0.08)' }, title: { display: true, text: '건수(감정별 합)' } },
    },
  };


  // 렌더는 조건부(훅은 위에서 항상 실행)
  if (!open) return null;

  return (
    <div className="metric-modal">
      <div className="metric-sheet" style={{ maxWidth: 980 }}>
        <div className="metric-head">
          <div className="metric-title">시간대 활동 그래프 — {dateKey}</div>
          <button className="btn" onClick={onClose} aria-label="닫기">닫기</button>
        </div>

        {loading ? (
          <div className="muted" style={{ padding: 16 }}>불러오는 중…</div>
        ) : hourly?.error ? (
          <div className="muted" style={{ padding: 16, color: 'crimson' }}>{hourly.error}</div>
        ) : (
          <>
            <div className="panel">
              <div className="panel-title">시간대별 메시지 수</div>
              <div style={{ height: 220 }}><Bar data={barData} options={barOpts} /></div>
            </div>

            <div className="panel">
              <div className="panel-title">시간대별 감정 분포(상위 {Math.min(TOP_EMO_K, (hourly?.topEmos || []).length)}개 + 무라벨, 스택)</div>
              <div style={{ height: 260 }}><Bar data={stackedData} options={stackedOpts} /></div>
              <div className="muted" style={{ marginTop: 6 }}>
                * 무라벨=해당 시간대 메시지 중 감정 배열이 없었던 건수.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 메인 컴포넌트
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

  // 포인트 클릭 → 시간대 모달
  const chartRef = useRef(null);
  const [hourModalOpen, setHourModalOpen] = useState(false);
  const [hourModalDate, setHourModalDate] = useState(null);

  // 중복 요청 취소용
  const abortRef = useRef(null);

  // 로그인 확인
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthed(!!u);
      setUid(u?.uid || null);
      if (!u) {
        RANGE_CACHE.clear();
        abortRef.current?.abort?.();
        setRows([]);
      }
      setErr(u ? '' : '로그인이 필요합니다.');
    });
    return () => unsub();
  }, []);

  // 메인 로드
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

      if (DEBUG) console.log('[EmotionGraph] completed(rows) →', completed);

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

  // rows => 집계/차트 데이터
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

  // Chart.js 데이터셋
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
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        spanGaps: true,
      };
    });
    return { labels: dates, datasets };
  }, [dates, uniqueEmotions, byDate]);

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
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
          labels: { boxWidth: 12, color: '#3e3a36', usePointStyle: true, pointStyle: 'line' },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          // 0/빈값 숨김
          filter: (item) => {
            const v = item.parsed?.y ?? item.raw;
            return v != null && !Number.isNaN(v) && v !== 0;
          },
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed?.y ?? ctx.raw;
              if (!v) return null;
              return `${ctx.dataset.label}: ${ctx.formattedValue}`;
            },
            itemSort: (a, b) => (b.parsed?.y ?? 0) - (a.parsed?.y ?? 0),
          },
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
      // 포인트 클릭 핸들링
      onClick: async (evt) => {
        const chart = chartRef.current;
        if (!chart) return;
        const points = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
        if (!points?.length) return;
        const { index } = points[0];
        const clickedDate = data?.labels?.[index];
        if (!isDateKey(clickedDate)) return;
        setHourModalDate(clickedDate);
        setHourModalOpen(true);
      },
    }),
    [mode, year, month, data?.labels]
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="muted" title="차트 포인트(●)를 클릭하면 해당 날짜의 시간대(0~23h) 그래프가 열립니다.">
            포인트 클릭 → 시간대 그래프
          </span>
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
          <Line ref={chartRef} data={data} options={options} />
        )}
      </div>

      {/* 시간대 모달 */}
      <HourlyModal
        open={hourModalOpen}
        onClose={() => setHourModalOpen(false)}
        dateKey={hourModalDate}
        uid={uid}
      />
    </div>
  );
}
