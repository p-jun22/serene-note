// src/components/EmotionGraphPage.js
// 날짜/월별 감정 분포 라인 그래프 (Chart.js + react-chartjs-2)
// - 의존성: chart.js ^4, react-chartjs-2 ^5
// - 백엔드 응답 스키마 자동 적응:
//   A) [{ dateKey:"YYYY-MM-DD", emotions:["슬픔","불안", ...] }, ...]
//   B) { "YYYY-MM-DD": { emotions:["..."], counts:{ "슬픔":2, ... } }, ... }

import React, { useEffect, useMemo, useState } from 'react';
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

// YYYY-MM-DD (KST) 고정 포맷
function ymdKST(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// KST 기준 N일 전
function daysAgoKST(n) {
  const now = new Date();
  return ymdKST(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
}

// 월 유틸
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

export default function EmotionGraphPage() {
  // 보기 모드: 'month' | 'range'
  const [mode, setMode] = useState('month'); // 기본: 월별
  // 월 피벗(첫날)
  const [pivot, setPivot] = useState(toFirstOfMonth(new Date()));
  const { from: mFrom, to: mTo, year, month } = useMemo(() => monthRangeOf(pivot), [pivot]);

  // 기간 모드용
  const [from, setFrom] = useState(daysAgoKST(6));
  const [to, setTo] = useState(daysAgoKST(0));

  // 공통
  const finalFrom = mode === 'month' ? mFrom : from;
  const finalTo = mode === 'month' ? mTo : to;

  const [rows, setRows] = useState([]); // 표준화된 [{dateKey, emotions:[]}]
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [authed, setAuthed] = useState(false);

  // 로그인 확인
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthed(!!u);
      setErr(u ? '' : '로그인이 필요합니다.');
    });
    return () => unsub();
  }, []);

  // 백엔드 응답 → 표준 rows로 정규화
  function normalizeResponse(payload) {
    // 케이스 A: { data: [...] }
    const arr = Array.isArray(payload?.data) ? payload.data : null;

    // 케이스 B: 객체 맵
    const obj =
      payload && !Array.isArray(payload) && !Array.isArray(payload?.data) ? payload : null;

    const out = [];

    if (arr) {
      for (const r of arr) {
        const dateKey = r?.dateKey || '';
        const emotions = Array.isArray(r?.emotions) ? r.emotions.filter(Boolean) : [];
        if (dateKey) out.push({ dateKey, emotions });
      }
      return out;
    }

    if (obj) {
      for (const [dateKey, v] of Object.entries(obj)) {
        const emotions = Array.isArray(v?.emotions) ? v.emotions.filter(Boolean) : [];
        // counts만 있고 emotions 없으면 counts 키를 emotions로 펼침
        if (!emotions.length && v?.counts && typeof v.counts === 'object') {
          const expanded = [];
          for (const [emo, n] of Object.entries(v.counts)) {
            for (let i = 0; i < (typeof n === 'number' ? n : 0); i++) expanded.push(emo);
          }
          out.push({ dateKey, emotions: expanded });
        } else {
          out.push({ dateKey, emotions });
        }
      }
      return out;
    }

    return [];
  }

  const load = async () => {
    if (!authed) return;
    try {
      setLoading(true);
      setErr('');
      // ⚠️ baseURL이 http://localhost:5000/api 라면 이 경로는 '/emotions'가 맞음
      const res = await api.get('/emotions', { params: { from: finalFrom, to: finalTo } });
      setRows(normalizeResponse(res.data));
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || '그래프 로드 오류');
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  // 기간/월/로그인 바뀔 때마다 로드
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalFrom, finalTo, authed]);

  // rows -> 날짜별 감정 카운트 집계
  const { dates, uniqueEmotions, byDate } = useMemo(() => {
    const dateSet = new Set();
    const emoSet = new Set();
    const map = new Map(); // dateKey -> { [emotion]: count }

    for (const r of rows) {
      const key = r?.dateKey;
      if (!key) continue;
      dateSet.add(key);

      const counts = map.get(key) || {};
      (r.emotions || []).forEach((emo) => {
        if (!emo) return;
        emoSet.add(emo);
        counts[emo] = (counts[emo] || 0) + 1;
      });
      map.set(key, counts);
    }

    const sortedDates = Array.from(dateSet).sort();
    return {
      dates: sortedDates,
      uniqueEmotions: Array.from(emoSet),
      byDate: map,
    };
  }, [rows]);

  // Chart.js datasets 구성
  const data = useMemo(() => {
    const datasets = uniqueEmotions.map((emo, idx) => {
      const color = `hsl(${(idx * 57) % 360} 70% 50%)`; // 감정별 고유색(규칙적 HSL)
      const arr = dates.map((d) => (byDate.get(d)?.[emo] || 0));
      return {
        label: emo,
        data: arr,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.35,
      };
    });

    return {
      labels: dates,
      datasets,
    };
  }, [dates, uniqueEmotions, byDate]);

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
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
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.formattedValue}`,
          },
        },
      },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { color: '#3e3a36' },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
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

      {/* 컨트롤 영역 */}
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
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
          <button className="btn" onClick={load} disabled={loading || !authed}>
            {loading ? '불러오는 중…' : '새로고침'}
          </button>
          {err && <span style={{ color: 'crimson' }}>그래프 오류: {String(err)}</span>}
          {!authed && <span className="muted">로그인 후 확인하세요.</span>}
        </div>
      )}

      {/* 차트 */}
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
              padding: 16,
            }}
          >
            {loading
              ? '데이터를 불러오는 중입니다…'
              : '표시할 데이터가 없습니다.\n(해당 기간에 기록이 없을 수 있어요.)'}
          </div>
        ) : (
          <Line data={data} options={options} />
        )}
      </div>
    </div>
  );
}
