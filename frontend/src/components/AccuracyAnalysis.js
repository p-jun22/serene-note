// src/components/AccuracyAnalysis.js
// ─────────────────────────────────────────────────────────────────────────────
// [역할]
// - 날짜 범위: 메시지 단위 확신도/보조지표를 날짜별 평균으로 시각화
// - 진행(대화 순번): 선택 날짜의 대화들을 생성순으로 정렬한 뒤 1..N 순번에 따른 평균 지표 변화 시각화
//
// [원칙]
// - 조회 전용(쓰기 없음). 엔드포인트/스키마 변경 없음.
// - LLM 확신도: snapshot.llm.confidences 우선, 없으면 snapshot.confidences 허용
// - HF 지표: snapshot.hf.* 우선, 없으면 m.hf_raw.* fallback 허용
// - 발표용: HF를 메인으로 먼저 노출, 상태/커버리지 배지 제공, 콘솔 로그 제거
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';

/* ───── 날짜 유틸 ───── */
function ymdKST(d) {
  if (!(d instanceof Date)) d = new Date(d);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}
function addDays(d, delta) { const t = new Date(d); t.setDate(t.getDate() + delta); return t; }
function rangeDays(startKey, endKey) {
  const out = []; const sd = new Date(startKey); const ed = new Date(endKey);
  for (let d = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate()); d <= ed; d.setDate(d.getDate() + 1)) {
    out.push(ymdKST(d));
  }
  return out;
}
function mean(arr) { const xs = (arr || []).filter(v => Number.isFinite(v)); return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null; }

/* ───── 아주 가벼운 SVG 라인차트(의존성 X) ───── */
function LineChart({ title, data, height = 160 }) {
  const padding = 32;
  const width = Math.max(360, Math.min(900, (data?.length || 1) * 42));
  const xs = data || [];
  const ys = xs.map(p => (p?.y ?? null)).filter(v => v !== null && Number.isFinite(v));
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 1;
  const y0 = minY === maxY ? minY - 0.5 : minY;
  const y1 = minY === maxY ? maxY + 0.5 : maxY;
  const innerW = width - padding * 2, innerH = height - padding * 2;

  const points = xs.map((p, i) => {
    const x = padding + (xs.length <= 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);
    const yVal = p?.y;
    const y = yVal === null || !Number.isFinite(yVal) ? null : padding + (1 - ((yVal - y0) / (y1 - y0))) * innerH;
    return { x, y };
  });

  let d = '';
  for (const pt of points) { if (pt.y == null) continue; d += (d ? ' L ' : 'M ') + `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`; }

  const yTicks = 4, ticks = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = y0 + (i / yTicks) * (y1 - y0);
    const y = padding + (1 - (i / yTicks)) * innerH;
    ticks.push({ v, y });
  }

  return (
    <div className="card" style={{ overflowX: 'auto', marginBottom: 16 }}>
      <div style={{ fontWeight: 600, margin: '6px 0 8px' }}>{title}</div>
      <svg width={width} height={height}>
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="currentColor" opacity="0.25" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="currentColor" opacity="0.25" />
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padding - 4} y1={t.y} x2={width - padding} y2={t.y} stroke="currentColor" opacity="0.07" />
            <text x={padding - 8} y={t.y + 4} textAnchor="end" fontSize="10">{Number.isFinite(t.v) ? t.v.toFixed(2) : '-'}</text>
          </g>
        ))}
        {xs.map((p, i) => {
          const x = padding + (xs.length <= 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);
          const label = String(p?.x ?? '').slice(5);
          return <text key={i} x={x} y={height - padding + 14} textAnchor="middle" fontSize="10">{label || (i+1)}</text>;
        })}
        {d && <path d={d} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.9" />}
        {points.map((pt, i) => (pt.y == null ? null : <circle key={i} cx={pt.x} cy={pt.y} r="3" fill="currentColor" />))}
      </svg>
    </div>
  );
}

/* ───── 메인 컴포넌트 ───── */
export default function AccuracyAnalysis() {
  // 탭: 'date' | 'progress'
  const [tab, setTab] = useState('date');

  // 날짜 평균 탭 상태
  const today = useMemo(() => ymdKST(new Date()), []);
  const defaultStart = useMemo(() => ymdKST(addDays(new Date(), -13)), []);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(today);

  // 진행(대화 순번) 탭 상태
  const [focusDate, setFocusDate] = useState(endDate);

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);             // 날짜 평균 결과 [{dateKey, metrics:{...}}]
  const [coverage, setCoverage] = useState({        // 날짜 평균 커버리지 배지
    days: 0, userMsgs: 0, hfMsgs: 0
  });
  const [progressRows, setProgressRows] = useState([]); // 순번 분석 결과

  /* ──────────────────────────────────────────────────────────────────────────
   * [A] 날짜 범위 평균
   * ────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (tab !== 'date') return;
    (async () => {
      setLoading(true);
      try {
        // 1) 달력 → convSet
        const calRes = await api.get('/calendar', { params: { startDateKey: startDate, endDateKey: endDate } });
        const byDate = calRes?.data?.data || {};
        const dates = rangeDays(startDate, endDate);
        const out = [];
        let msgSum = 0; let hfSum = 0;

        for (const dateKey of dates) {
          const convIds = Object.keys(byDate?.[dateKey]?.convSet || {});
          if (!convIds.length) { out.push({ dateKey, metrics: {} }); continue; }

          // 2) 각 대화 메시지(유저만) 수집 → 확신도/보조지표 평균
          const metrics = {
            llm_emotions: [], llm_distortions: [], llm_coreBelief: [], llm_question: [],
            hf_emotions_avg: [], hf_emotion_entropy: [], hf_core_entail: [], hf_core_contradict: []
          };

          const allMsgsPerConv = await Promise.all(
            convIds.map(cid =>
              api.get(`/conversations/${cid}/messages`, { params: { sessionId: dateKey, limit: 1000 } })
                .then(r => r?.data?.data || [])
                .catch(() => [])
            )
          );

          for (const msgs of allMsgsPerConv) {
            for (const m of msgs) {
              if (m.role !== 'user') continue;
              msgSum += 1;

              const snap = m?.analysisSnapshot_v1 || {};
              const llmConf = snap?.llm?.confidences || snap?.confidences || {};
              if (Number.isFinite(llmConf.emotions))    metrics.llm_emotions.push(llmConf.emotions);
              if (Number.isFinite(llmConf.distortions)) metrics.llm_distortions.push(llmConf.distortions);
              if (Number.isFinite(llmConf.coreBelief))  metrics.llm_coreBelief.push(llmConf.coreBelief);
              if (Number.isFinite(llmConf.question))    metrics.llm_question.push(llmConf.question);

              let hasHF = false;
              const hfBlock = snap?.hf || null;
              if (hfBlock) {
                const eavg = hfBlock?.emotion?.avg;
                const entr = hfBlock?.emotion?.entropy;
                const entl = hfBlock?.nli?.core?.entail;
                const cont = hfBlock?.nli?.core?.contradict;
                if (Number.isFinite(eavg)) { metrics.hf_emotions_avg.push(eavg); hasHF = true; }
                if (Number.isFinite(entr)) { metrics.hf_emotion_entropy.push(entr); hasHF = true; }
                if (Number.isFinite(entl)) { metrics.hf_core_entail.push(entl); hasHF = true; }
                if (Number.isFinite(cont)) { metrics.hf_core_contradict.push(cont); hasHF = true; }
              } else {
                const raw = m?.hf_raw || {};
                const eavg = raw?.emotions_avg ?? raw?.emotion?.avg;
                const entr = raw?.emotion_entropy ?? raw?.emotion?.entropy;
                const entl = raw?.core_entail ?? raw?.nli_core?.entail ?? raw?.nli?.core?.entail;
                const cont = raw?.core_contradict ?? raw?.nli_core?.contradict ?? raw?.nli?.core?.contradict;
                if (Number.isFinite(eavg)) { metrics.hf_emotions_avg.push(eavg); hasHF = true; }
                if (Number.isFinite(entr)) { metrics.hf_emotion_entropy.push(entr); hasHF = true; }
                if (Number.isFinite(entl)) { metrics.hf_core_entail.push(entl); hasHF = true; }
                if (Number.isFinite(cont)) { metrics.hf_core_contradict.push(cont); hasHF = true; }
              }
              if (hasHF) hfSum += 1;
            }
          }

          const avg = Object.fromEntries(Object.entries(metrics).map(([k, arr]) => [k, mean(arr)]));
          out.push({ dateKey, metrics: avg });
        }

        setRows(out);
        setCoverage({ days: dates.length, userMsgs: msgSum, hfMsgs: hfSum });
      } catch {
        alert('정확도 분석(날짜별 평균) 데이터를 불러오지 못했어요.');
        setRows([]);
        setCoverage({ days: 0, userMsgs: 0, hfMsgs: 0 });
      } finally {
        setLoading(false);
      }
    })();
  }, [tab, startDate, endDate]);

  const series = useMemo(() => {
    const xs = rows || [];
    const toSeries = (key) => xs.map(r => ({ x: r.dateKey, y: r.metrics?.[key] ?? null }));
    return {
      // HF 먼저(메인)
      hf_emotions_avg: toSeries('hf_emotions_avg'),
      hf_emotion_entropy: toSeries('hf_emotion_entropy'),
      hf_core_entail: toSeries('hf_core_entail'),
      hf_core_contradict: toSeries('hf_core_contradict'),
      // LLM 나중
      llm_emotions: toSeries('llm_emotions'),
      llm_distortions: toSeries('llm_distortions'),
      llm_coreBelief: toSeries('llm_coreBelief'),
      llm_question: toSeries('llm_question'),
    };
  }, [rows]);

  /* ──────────────────────────────────────────────────────────────────────────
   * [B] 진행(대화 순번) 분석
   * ────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (tab !== 'progress') return;
    (async () => {
      setLoading(true);
      try {
        // 1) focusDate의 convSet
        const calRes = await api.get(`/calendar/${focusDate}`);
        const convSet = calRes?.data?.data?.convSet || {};
        const convIds = Object.keys(convSet);
        if (!convIds.length) { setProgressRows([]); setLoading(false); return; }

        // 2) 각 대화의 createdAt 기준으로 정렬(1..N 순번)
        const convMetas = await Promise.all(
          convIds.map(async (cid) => {
            const conv = await api.get(`/conversations/${cid}`, { params: { sessionId: focusDate } })
              .then(r => r?.data?.data || null).catch(()=>null);
            return { id: cid, createdAt: conv?.createdAt?._seconds || 0 };
          })
        );
        convMetas.sort((a,b)=> (a.createdAt||0) - (b.createdAt||0));

        // 3) 각 대화별 유저 메시지 수집 → 평균 지표 계산
        const seqMetrics = []; // [{ idx:1, metrics:{...} }, ...]
        for (let i=0; i<convMetas.length; i++){
          const cid = convMetas[i].id;
          const msgs = await api.get(`/conversations/${cid}/messages`, { params: { sessionId: focusDate, limit: 1000 } })
            .then(r => r?.data?.data || [])
            .catch(()=>[]);

          const bucket = {
            llm_emotions: [], llm_distortions: [], llm_coreBelief: [], llm_question: [],
            hf_emotions_avg: [], hf_emotion_entropy: [], hf_core_entail: [], hf_core_contradict: []
          };

          for (const m of msgs){
            if (m.role !== 'user') continue;
            const snap = m?.analysisSnapshot_v1 || {};
            const llmConf = snap?.llm?.confidences || snap?.confidences || {};
            if (Number.isFinite(llmConf.emotions))    bucket.llm_emotions.push(llmConf.emotions);
            if (Number.isFinite(llmConf.distortions)) bucket.llm_distortions.push(llmConf.distortions);
            if (Number.isFinite(llmConf.coreBelief))  bucket.llm_coreBelief.push(llmConf.coreBelief);
            if (Number.isFinite(llmConf.question))    bucket.llm_question.push(llmConf.question);

            const hfBlock = snap?.hf || null;
            if (hfBlock) {
              const eavg = hfBlock?.emotion?.avg;
              const entr = hfBlock?.emotion?.entropy;
              const entl = hfBlock?.nli?.core?.entail;
              const cont = hfBlock?.nli?.core?.contradict;
              if (Number.isFinite(eavg)) bucket.hf_emotions_avg.push(eavg);
              if (Number.isFinite(entr)) bucket.hf_emotion_entropy.push(entr);
              if (Number.isFinite(entl)) bucket.hf_core_entail.push(entl);
              if (Number.isFinite(cont)) bucket.hf_core_contradict.push(cont);
            } else {
              const raw = m?.hf_raw || {};
              const eavg = raw?.emotions_avg ?? raw?.emotion?.avg;
              const entr = raw?.emotion_entropy ?? raw?.emotion?.entropy;
              const entl = raw?.core_entail ?? raw?.nli_core?.entail ?? raw?.nli?.core?.entail;
              const cont = raw?.core_contradict ?? raw?.nli_core?.contradict ?? raw?.nli?.core?.contradict;
              if (Number.isFinite(eavg)) bucket.hf_emotions_avg.push(eavg);
              if (Number.isFinite(entr)) bucket.hf_emotion_entropy.push(entr);
              if (Number.isFinite(entl)) bucket.hf_core_entail.push(entl);
              if (Number.isFinite(cont)) bucket.hf_core_contradict.push(cont);
            }
          }

          const avg = Object.fromEntries(Object.entries(bucket).map(([k, arr]) => [k, mean(arr)]));
          seqMetrics.push({ idx: i+1, metrics: avg });
        }

        setProgressRows(seqMetrics);
      } catch {
        alert('정확도 분석(진행) 데이터를 불러오지 못했어요.');
        setProgressRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [tab, focusDate]);

  const progressSeries = useMemo(() => {
    const xs = progressRows || [];
    const toSeries = (key) => xs.map(r => ({ x: String(r.idx), y: r.metrics?.[key] ?? null }));
    return {
      // HF 먼저
      hf_emotions_avg: toSeries('hf_emotions_avg'),
      hf_emotion_entropy: toSeries('hf_emotion_entropy'),
      hf_core_entail: toSeries('hf_core_entail'),
      hf_core_contradict: toSeries('hf_core_contradict'),
      // LLM 나중
      llm_emotions: toSeries('llm_emotions'),
      llm_distortions: toSeries('llm_distortions'),
      llm_coreBelief: toSeries('llm_coreBelief'),
      llm_question: toSeries('llm_question'),
    };
  }, [progressRows]);

  /* ───── 렌더 ───── */
  return (
    <div className="page-wrap" style={{ padding: 16 }}>
      {/* 탭 / 컨트롤 */}
      <div className="toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>정확도 분석</div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          <button className={`btn ${tab==='date'?'primary':''}`} onClick={()=>setTab('date')}>날짜별 평균</button>
          <button className={`btn ${tab==='progress'?'primary':''}`} onClick={()=>setTab('progress')}>진행(대화 순번)</button>
        </div>
        <div style={{ flex: 1 }} />

        {tab === 'date' && (
          <>
            <label className="muted" style={{ fontSize: 12 }}>시작</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <label className="muted" style={{ fontSize: 12 }}>종료</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            <span className={`chip ${coverage.hfMsgs>0?'good':'warn'}`} title="HF 지표가 있는 유저 메시지 수 / 전체 유저 메시지 수">
              HF 커버리지: {coverage.hfMsgs}/{coverage.userMsgs}
            </span>
            <span className="chip" title="선택된 날짜 수">일수: {coverage.days}</span>
          </>
        )}

        {tab === 'progress' && (
          <>
            <label className="muted" style={{ fontSize: 12 }}>분석 날짜</label>
            <input type="date" value={focusDate} onChange={(e) => setFocusDate(e.target.value)} />
          </>
        )}
      </div>

      {loading && <div style={{ padding: 8 }}>불러오는 중…</div>}

      {!loading && tab === 'date' && (
        <>
          {/* HF 먼저(메인) */}
          <LineChart title="HF: emotions_avg (날짜별 평균)" data={series.hf_emotions_avg} />
          <LineChart title="HF: emotion_entropy (날짜별 평균)" data={series.hf_emotion_entropy} />
          <LineChart title="HF: core_entail (날짜별 평균)" data={series.hf_core_entail} />
          <LineChart title="HF: core_contradict (날짜별 평균)" data={series.hf_core_contradict} />

          {/* LLM 다음 */}
          <LineChart title="LLM: 감정 확신도 (날짜별 평균)" data={series.llm_emotions} />
          <LineChart title="LLM: 인지왜곡 확신도 (날짜별 평균)" data={series.llm_distortions} />
          <LineChart title="LLM: 핵심믿음 확신도 (날짜별 평균)" data={series.llm_coreBelief} />
          <LineChart title="LLM: 질문 적합도 (날짜별 평균)" data={series.llm_question} />
        </>
      )}

      {!loading && tab === 'progress' && (
        <>
          {/* HF 먼저(메인) */}
          <LineChart title="HF: emotions_avg (대화 순번)" data={progressSeries.hf_emotions_avg} />
          <LineChart title="HF: emotion_entropy (대화 순번)" data={progressSeries.hf_emotion_entropy} />
          <LineChart title="HF: core_entail (대화 순번)" data={progressSeries.hf_core_entail} />
          <LineChart title="HF: core_contradict (대화 순번)" data={progressSeries.hf_core_contradict} />

          {/* LLM 다음 */}
          <LineChart title="LLM: 감정 확신도 (대화 순번)" data={progressSeries.llm_emotions} />
          <LineChart title="LLM: 인지왜곡 확신도 (대화 순번)" data={progressSeries.llm_distortions} />
          <LineChart title="LLM: 핵심믿음 확신도 (대화 순번)" data={progressSeries.llm_coreBelief} />
          <LineChart title="LLM: 질문 적합도 (대화 순번)" data={progressSeries.llm_question} />
        </>
      )}
    </div>
  );
}
