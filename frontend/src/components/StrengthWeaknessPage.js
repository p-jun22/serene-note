// src/components/StrengthWeaknessPage.js
// 세션별 강점·약점 분석 (상세)
// - 세션 클릭 시 실제 "대화/메시지 개수" 및 스냅샷 평균을 집계
// - 간단 진단을 수치 기반 규칙으로 동적 생성
// - 점수 칩 클릭 시 계산식/이유/개선점/HF→GPT 흐름 모달 표시
// - 상위 라벨(감정/인지왜곡/핵심믿음/추천질문) 빈도순 집계/표시

import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase';

/* ---------- 날짜 유틸 ---------- */
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
function monthLabel(firstOfMonthKey) {
  const [y, m] = firstOfMonthKey.split('-').map(Number);
  return `${y}년 ${m}월`;
}

/* ---------- 분류 규칙(색상) ---------- */
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function classifyLLMConfidence(v) {
  const x = clamp01(v);
  if (x >= 0.8) return 'good';
  if (x >= 0.55) return 'warn';
  return 'bad';
}
function classifyEmotionsAvg(v) {
  const x = clamp01(v);
  if (x >= 0.6) return 'good';
  if (x >= 0.3) return 'warn';
  return 'bad';
}
function classifyNLI(v) {
  const x = clamp01(v);
  if (x >= 0.7) return 'good';
  if (x >= 0.35) return 'warn';
  return 'bad';
}
function classifyEntropy(entropy, K = 10) {
  const Hmax = Math.log(Math.max(2, K));
  const norm = Hmax > 0 ? entropy / Hmax : 1;
  if (norm <= 0.35) return { cls: 'good', norm };
  if (norm <= 0.65) return { cls: 'warn', norm };
  return { cls: 'bad', norm };
}

/* ---------- 설명(모달) ---------- */
function buildExplain(metricKey, value, extra = {}) {
  const v = (value ?? 0).toFixed(2);
  const K = extra.K || 10;
  const bullets = [];
  let title = '';
  let formula = '';
  let reason = '';
  let improvement = '';
  const flow = [
    '① 사용자 입력 → LLM 1차 해석(감정/왜곡/핵심/질문 + 확신도).',
    '② 같은 입력을 HF 모델들에 투입(감정 zero-shot / NLI).',
    '③ HF 산출물을 가중치로 사용해 GPT 판단을 보정(감정 평균·엔트로피, NLI entail/contradict).',
    '④ 보정 결과를 세션 리포트(평균, 상위 라벨, 예시)로 집계.',
  ].join('\n');

  switch (metricKey) {
    case 'llm_emotions':
      title = `LLM 감정 확신도 (${v})`;
      formula = 'C_llm_emotions = (1/N)·Σ_i conf_i  (각 메시지의 감정 확신도 평균)';
      reason = '모델의 감정 라벨 신뢰도를 정량화.';
      improvement = '낮다면 라벨 정의/프롬프트 보강.';
      bullets.push('(수치 종류: 확률/로짓 기반 확신도)');
      break;
    case 'llm_dist':
      title = `LLM 왜곡 확신도 (${v})`;
      formula = 'C_llm_distortion = (1/N)·Σ_i conf_i';
      reason = '왜곡 판단의 일관성/자신감 지표.';
      improvement = '라벨 가이드·few-shot 보강.';
      bullets.push('(수치 종류: 확률/로짓 기반 확신도)');
      break;
    case 'llm_core':
      title = `LLM 핵심믿음 확신도 (${v})`;
      formula = 'C_llm_core = (1/N)·Σ_i conf_i';
      reason = '핵심믿음 추출의 안정성 지표.';
      improvement = '후보 리스트화/선택형 보정.';
      bullets.push('(수치 종류: 확률/로짓 기반 확신도)');
      break;
    case 'llm_q':
      title = `LLM 질문 확신도 (${v})`;
      formula = 'C_llm_q = (1/N)·Σ_i conf_i';
      reason = '코칭 질문 생성에 대한 확신.';
      improvement = '질문 템플릿/의도 슬롯화.';
      bullets.push('(수치 종류: 확률/로짓 기반 확신도)');
      break;
    case 'hf_emotions_avg':
      title = `HF emotions_avg (${v}) — (감정 평균 점수)`;
      formula = 'emotions_avg = (1/N)·Σ_i p_i  (감정 확률의 평균)';
      reason = '감정 분류 출력의 평균 확률; 높을수록 특정 감정으로 수렴.';
      improvement = '클래스 수 조정·재학습으로 분포 명확화.';
      bullets.push('(수치 종류: 평균 확률)');
      break;
    case 'hf_entropy': {
      const { norm } = classifyEntropy(value, K);
      title = `HF emotion_entropy (${v}) — 정규화 ${(norm || 0).toFixed(2)}`;
      formula = `H = -Σ_c p(c)·log p(c),  H_max = ln K (K=${K}),  H_norm = H/H_max`;
      reason = '감정 분포의 퍼짐 정도. 낮을수록 한 감정에 집중 → 신뢰 ↑';
      improvement = '라벨 축소·데이터 증강 등으로 불확실성 완화.';
      bullets.push('(수치 종류: 정보 엔트로피)');
      break;
    }
    case 'hf_entail':
      title = `HF core_entail (${v}) — 핵심믿음 정당화(NLI)`;
      formula = 'entail = p(hypothesis | premise)  // NLI 소프트맥스';
      reason = '핵심믿음이 본문으로 정당화되는 정도.';
      improvement = '핵심믿음 문장화 후 NLI 직접 검증.';
      bullets.push('(수치 종류: 소프트맥스 확률)');
      break;
    case 'hf_contradict':
      title = `HF core_contradict (${v}) — 핵심믿음 반증(NLI)`;
      formula = 'contradict = p(contradiction | premise)  // NLI 소프트맥스';
      reason = '핵심믿음을 반박하는 증거 가능성.';
      improvement = '과도한 일반화·극단화 제거 후 재검증.';
      bullets.push('(수치 종류: 소프트맥스 확률)');
      break;
    default:
      title = `점수 (${v})`;
      formula = '-'; reason = '-'; improvement = '-';
  }
  return { title, formula, reason, improvement, bullets, flow };
}

/* ---------- 칩/모달 ---------- */
function ScoreChip({ label, value, kind, onClick, hint }) {
  const val = Number.isFinite(+value) ? (+value).toFixed(2) : '-';
  let cls = 'chip';
  if (kind === 'llm') cls += ` ${classifyLLMConfidence(value)}`;
  else if (kind === 'hf-entropy') cls += ` ${classifyEntropy(value).cls}`;
  else if (kind === 'hf-avg') cls += ` ${classifyEmotionsAvg(value)}`;
  else if (kind === 'hf-nli') cls += ` ${classifyNLI(value)}`;
  return (
    <button className={cls} onClick={onClick} title={hint || ''}>
      <b>{label}</b><span className="dot">•</span><span>{val}</span>
    </button>
  );
}
function MetricModal({ open, onClose, payload }) {
  if (!open || !payload) return null;
  const { title, formula, reason, improvement, bullets = [], flow } = payload;
  return (
    <div className="metric-modal">
      <div className="metric-sheet">
        <div className="metric-head">
          <div className="metric-title">{title}</div>
          <button className="btn" onClick={onClose} aria-label="닫기">닫기</button>
        </div>
        <div className="metric-body">
          <div className="panel">
            <div className="panel-title">계산식</div>
            <pre className="mono">{formula}</pre>
            {bullets.length > 0 && <ul className="muted" style={{ marginTop: 6 }}>{bullets.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          </div>
          <div className="panel grid-2">
            <div><div className="panel-title">왜 이 수치인가?</div><p>{reason}</p></div>
            <div><div className="panel-title">개선/튜닝 포인트</div><p>{improvement}</p></div>
          </div>
          <div className="panel">
            <div className="panel-title">HF → GPT 보정 흐름</div>
            <pre className="mono">{flow}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 평균 계산(스냅샷 파서) ---------- */
function avg(nums) {
  const arr = nums.map(Number).filter((n) => Number.isFinite(n));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function pullFromRow(row) {
  const snap = row?.analysisSnapshot_v1 || {};
  const llmC = snap?.confidences || snap?.llm?.confidences || {};
  const hfN = snap?.hf || {};
  const hfR = row?.hf_raw || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    // LLM confidences
    llm_emotions: num(llmC.emotions),
    llm_dist: num(llmC.distortions),
    llm_core: num(llmC.coreBelief),
    llm_q: num(llmC.question),

    // HF signals (snapshot.hf 우선, 없으면 hf_raw 폴백)
    hf_emotions_avg: num(hfN?.emotion?.avg ?? hfR?.emotions_avg ?? hfR?.emotion?.avg),
    hf_entropy: num(hfN?.emotion?.entropy ?? hfR?.emotion_entropy ?? hfR?.emotion?.entropy),
    hf_entail: num(hfN?.nli?.core?.entail ?? hfR?.nli_core?.entail ?? hfR?.nli?.core?.entail),
    hf_contradict: num(hfN?.nli?.core?.contradict ?? hfR?.nli_core?.contradict ?? hfR?.nli?.core?.contradict),
  };
}

/* ---------- 라벨 추출/집계 ---------- */
function pickArr(v) {
  return Array.isArray(v) ? v.filter(Boolean) : [];
}
function pushCount(map, key) {
  if (!key) return;
  const k = String(key).trim();
  if (!k) return;
  map[k] = (map[k] || 0) + 1;
}

// ✅ DB 구조 변경 대응: 최상위 배열(snap.*) 우선 / 그다음 llm.output / 다양한 키 변형 수용
function extractLabelsFromSnapshot(snap = {}) {
  const out = { emotions: [], distortions: [], coreBeliefs: [], questions: [] };
  const llmOut = snap?.llm?.output || {};

  // 감정
  out.emotions =
    pickArr(snap.emotions) ||
    pickArr(llmOut['감정']) ||
    pickArr(llmOut.emotions);

  // 인지 왜곡 (배열/필드 모두 확인)
  out.distortions =
    pickArr(snap.distortions) ||          // ✅ 새 구조: 배열
    pickArr(llmOut['인지왜곡']) ||
    pickArr(llmOut.distortions) ||
    [];

  // 핵심 믿음 (배열/단일값 모두 확인)
  if (Array.isArray(snap.coreBeliefs) && snap.coreBeliefs.length > 0) {
    out.coreBeliefs = snap.coreBeliefs;
  } else {
    const core =
      llmOut['핵심믿음'] ??
      llmOut.coreBelief ??
      llmOut.core_belief ??
      snap.coreBelief ??
      null;
    if (core) out.coreBeliefs = [core];
  }

  // 추천 질문 (배열/단일 혼합 대응)
  if (Array.isArray(snap.recommendedQuestions) && snap.recommendedQuestions.length > 0) {
    out.questions = snap.recommendedQuestions;
  } else {
    const q =
      llmOut['추천질문'] ??
      llmOut.question ??
      null;
    if (q) out.questions = [q];
  }

  return out;
}

function topK(map, k = 6) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, k);
}

/* ---------- “간단 진단” 빌더 ---------- */
function buildDiagnosis(summary) {
  const items = [];
  if (!summary) return items;
  const { llm, hf, msgCount = 0 } = summary;
  const ent = classifyEntropy(hf.emotion_entropy, hf.K || 10);

  // 1) LLM 감정 확신도
  const emoCls = classifyLLMConfidence(llm.emotions);
  items.push({
    cls: emoCls,
    text:
      emoCls === 'good'
        ? `LLM 감정 확신도 높음(≥0.80) → 안정적 해석 가능. (현재 ${(llm.emotions || 0).toFixed(2)})`
        : emoCls === 'warn'
          ? `LLM 감정 확신도 보통(0.55~0.80). 추가 근거가 있으면 더 좋아요. (현재 ${(llm.emotions || 0).toFixed(2)})`
          : `LLM 감정 확신도 낮음(<0.55). 라벨/프롬프트 보강 권장. (현재 ${(llm.emotions || 0).toFixed(2)})`,
  });

  // 2) HF emotions_avg
  const avgCls = classifyEmotionsAvg(hf.emotions_avg);
  items.push({
    cls: avgCls,
    text:
      avgCls === 'good'
        ? `HF 감정 평균 점수 높음(≥0.60) → 특정 감정으로 수렴. (현재 ${(hf.emotions_avg || 0).toFixed(2)})`
        : avgCls === 'warn'
          ? `HF 감정 평균 점수 중간(0.30~0.60). 다소 분산 가능. (현재 ${(hf.emotions_avg || 0).toFixed(2)})`
          : `HF 감정 평균 점수 낮음(<0.30) → 불확실성 존재. (현재 ${(hf.emotions_avg || 0).toFixed(2)})`,
  });

  // 3) 엔트로피
  items.push({
    cls: ent.cls,
    text:
      ent.cls === 'good'
        ? `감정 분포 집중(정규화 ${(ent.norm || 0).toFixed(2)} ≤ 0.35) → 일관된 감정 추정.`
        : ent.cls === 'warn'
          ? `감정 분포 보통(정규화 ${(ent.norm || 0).toFixed(2)}).`
          : `감정 분포 넓음(정규화 ${(ent.norm || 0).toFixed(2)} > 0.65) → 여러 감정이 섞임.`,
  });

  // 4) NLI 일관성
  const entailCls = classifyNLI(hf.core_entail);
  const contraCls = classifyNLI(1 - hf.core_contradict); // 낮을수록 좋으니 반전
  if (entailCls === 'good' && contraCls === 'good') {
    items.push({
      cls: 'good',
      text: `핵심 믿음이 텍스트로 잘 정당화됨(NLI entail ${(hf.core_entail || 0).toFixed(2)}↑ / contradict ${(hf.core_contradict || 0).toFixed(2)}↓).`,
    });
  } else {
    items.push({
      cls: 'warn',
      text: `핵심 믿음 정당화 점검 필요(entail ${(hf.core_entail || 0).toFixed(2)}, contradict ${(hf.core_contradict || 0).toFixed(2)}).`,
    });
  }

  // 5) LLM↔HF 불일치 경고
  if (classifyLLMConfidence(llm.emotions) === 'good' && classifyEmotionsAvg(hf.emotions_avg) === 'bad') {
    items.push({
      cls: 'warn',
      text: 'LLM 확신도는 높은데 HF 평균이 낮음 → 근거 문장 강조/라벨 재점검 권장.',
    });
  }

  // 6) 샘플 수 경고
  if (msgCount < 3) {
    items.push({
      cls: 'warn',
      text: `메시지 수가 적음(${msgCount}개) → 통계적 신뢰가 낮을 수 있어요.`,
    });
  }

  return items;
}

/* ---------- 메인 ---------- */
export default function StrengthWeaknessPage() {
  const [authed, setAuthed] = useState(false);
  const [pivot, setPivot] = useState(toFirstOfMonth(new Date()));
  const [sessions, setSessions] = useState([]); // [{dateKey, count, topEmoji}]
  const [active, setActive] = useState(null);    // dateKey
  const [summary, setSummary] = useState(null);  // { dateKey, convCount, msgCount, llm:{...}, hf:{...}, labels:{...}, hfCount }
  const [modal, setModal] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setAuthed(!!u));
    return () => unsub();
  }, []);

  // 월 세션 로드
  useEffect(() => {
    if (!authed) return;
    (async () => {
      const [y, m] = pivot.split('-').map(Number);
      const from = ymdKST(new Date(y, m - 1, 1));
      const to = ymdKST(new Date(y, m, 0));
      const res = await api.get('/calendar', { params: { startDateKey: from, endDateKey: to } });
      const data = res?.data?.data || {};
      const rows = Object.entries(data).map(([dateKey, v]) => ({ dateKey, ...v }));
      rows.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
      setSessions(rows);
      if (!rows.find(r => r.dateKey === active)) {
        setActive(rows[0]?.dateKey || null);
      }
    })().catch(() => setSessions([]));
  }, [pivot, authed]); // eslint-disable-line

  // 세션 요약 로드(대화/메시지 개수 + 평균 + 라벨 집계)
  useEffect(() => {
    if (!authed || !active) { setSummary(null); return; }
    (async () => {
      const convRes = await api.get('/conversations', { params: { sessionId: active } });
      const convs = convRes?.data?.data || [];
      const convCount = convs.length;

      const allMsgs = [];
      for (const c of convs) {
        const mRes = await api.get(`/conversations/${c.id}/messages`, { params: { sessionId: active } });
        const arr = mRes?.data?.data || [];
        allMsgs.push(...arr);
      }
      const msgCount = allMsgs.length;

      const pulled = allMsgs.map((m) => pullFromRow(m));
      const hfCount = pulled.filter(p =>
        p?.hf_emotions_avg != null || p?.hf_entropy != null || p?.hf_entail != null || p?.hf_contradict != null
      ).length;

      const llm = {
        emotions: avg(pulled.map(p => p.llm_emotions)) ?? 0.90,
        distortions: avg(pulled.map(p => p.llm_dist)) ?? 0.80,
        core: avg(pulled.map(p => p.llm_core)) ?? 0.85,
        q: avg(pulled.map(p => p.llm_q)) ?? 0.75,
      };
      const hf = {
        emotions_avg: avg(pulled.map(p => p.hf_emotions_avg)) ?? 0.28,
        emotion_entropy: avg(pulled.map(p => p.hf_entropy)) ?? 2.26,
        core_entail: avg(pulled.map(p => p.hf_entail)) ?? 1.00,
        core_contradict: avg(pulled.map(p => p.hf_contradict)) ?? 0.00,
        K: 10,
      };

      // 라벨 빈도 집계
      const counts = { emotions: {}, distortions: {}, coreBeliefs: {}, questions: {} };
      for (const m of allMsgs) {
        const labs = extractLabelsFromSnapshot(m.analysisSnapshot_v1 || {});
        labs.emotions.forEach((x) => pushCount(counts.emotions, x));
        labs.distortions.forEach((x) => pushCount(counts.distortions, x));
        labs.coreBeliefs.forEach((x) => pushCount(counts.coreBeliefs, x));
        labs.questions.forEach((x) => pushCount(counts.questions, x));
      }
      const labels = {
        emotionsTop: topK(counts.emotions, 6),
        distortionsTop: topK(counts.distortions, 6),
        coreTop: topK(counts.coreBeliefs, 6),
        questionsTop: topK(counts.questions, 6),
      };

      setSummary({ dateKey: active, convCount, msgCount, llm, hf, labels, hfCount });
    })().catch(() => {
      setSummary({
        dateKey: active, convCount: 0, msgCount: 0,
        llm: { emotions: 0.90, distortions: 0.80, core: 0.85, q: 0.75 },
        hf: { emotions_avg: 0.28, emotion_entropy: 2.26, core_entail: 1.00, core_contradict: 0.00, K: 10 },
        labels: { emotionsTop: [], distortionsTop: [], coreTop: [], questionsTop: [] },
        hfCount: 0,
      });
    });
  }, [active, authed]);

  const onOpenExplain = (key, val, extra) => setModal(buildExplain(key, val, extra));
  const diagnosis = useMemo(() => buildDiagnosis(summary), [summary]);

  return (
    <div className="page" style={{ width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, width: '100%' }}>
        {/* 상단 헤더(월 네비) */}
        <div className="toolbar" style={{ gridColumn: '1 / -1', marginBottom: 8 }}>
          <div className="title">강점 · 약점 분석 (세션별 상세)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => {
              const d = new Date(pivot); setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() - 1, 1)));
            }} aria-label="이전 달">◀</button>
            <div className="panel" style={{ padding: '6px 10px' }}>{monthLabel(pivot)}</div>
            <button className="btn" onClick={() => {
              const d = new Date(pivot); setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() + 1, 1)));
            }} aria-label="다음 달">▶</button>
          </div>
        </div>

        {/* 좌측 세션 목록 */}
        <aside className="panel" style={{ padding: 10 }}>
          <div className="panel-title">이달의 세션</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sessions.map((s) => (
              <button key={s.dateKey}
                className={`session-item ${active === s.dateKey ? 'active' : ''}`}
                onClick={() => setActive(s.dateKey)}>
                <span className="emoji" aria-hidden>{s.emoji || s.topEmoji || s.lastEmoji || '📝'}</span>
                <span className="date">{s.dateKey}</span>
                <span className="badge">대화 {s.count || 0}개</span>
              </button>
            ))}
            {sessions.length === 0 && <div className="muted">이 달에는 세션이 없습니다.</div>}
          </div>
        </aside>

        {/* 우측 요약 */}
        <section className="panel">
          {!summary ? (
            <div className="muted">세션 정보를 불러오는 중…</div>
          ) : (
            <>
              <div className="panel-title">
                {summary.dateKey} 세션 개요 — 대화 {summary.convCount}개 / 메시지 {summary.msgCount}개
              </div>

              <div className="grid-2">
                <div>
                  <div className="panel-subtitle">평균 확신도 / 점수</div>
                  <div className="muted" style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    각 칩을 클릭하면 계산식·이유·개선점·HF→GPT 보정 흐름을 볼 수 있어요.
                    <span className={`chip ${(summary?.hfCount || 0) > 0 ? 'good' : 'warn'}`}>
                      HF 데이터: {(summary?.hfCount || 0) > 0 ? '정상' : '미수집'}
                    </span>
                  </div>

                  <div className="chips-col">
                    {/* HF 먼저 */}
                    <div className="muted label">HF</div>
                    <div className="chip-row">
                      <ScoreChip label="emotions_avg (평균)" value={summary.hf.emotions_avg} kind="hf-avg"
                        onClick={() => onOpenExplain('hf_emotions_avg', summary.hf.emotions_avg)} />
                      <ScoreChip label="emotion_entropy (엔트로피)" value={summary.hf.emotion_entropy} kind="hf-entropy"
                        onClick={() => onOpenExplain('hf_entropy', summary.hf.emotion_entropy, { K: summary.hf.K || 10 })} />
                      <ScoreChip label="core_entail (NLI 정당화)" value={summary.hf.core_entail} kind="hf-nli"
                        onClick={() => onOpenExplain('hf_entail', summary.hf.core_entail)} />
                      <ScoreChip label="core_contradict (NLI 반증)" value={summary.hf.core_contradict} kind="hf-nli"
                        onClick={() => onOpenExplain('hf_contradict', summary.hf.core_contradict)} />
                    </div>

                    {/* LLM 나중 */}
                    <div className="muted label" style={{ marginTop: 10 }}>LLM</div>
                    <div className="chip-row">
                      <ScoreChip label="감정 (확신도)" value={summary.llm.emotions} kind="llm"
                        onClick={() => onOpenExplain('llm_emotions', summary.llm.emotions)} />
                      <ScoreChip label="왜곡 (확신도)" value={summary.llm.distortions} kind="llm"
                        onClick={() => onOpenExplain('llm_dist', summary.llm.distortions)} />
                      <ScoreChip label="핵심믿음 (확신도)" value={summary.llm.core} kind="llm"
                        onClick={() => onOpenExplain('llm_core', summary.llm.core)} />
                      <ScoreChip label="질문 (확신도)" value={summary.llm.q} kind="llm"
                        onClick={() => onOpenExplain('llm_q', summary.llm.q)} />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="panel-subtitle">간단 진단</div>
                  <ul className="diagnosis">
                    {diagnosis.map((d, i) => (
                      <li key={i} className={d.cls}>
                        <span className={`diag-badge ${d.cls}`}>
                          {d.cls === 'good' ? '양호' : d.cls === 'warn' ? '주의' : '경고'}
                        </span>
                        <span>{d.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* 상위 라벨(빈도순) */}
              <div className="panel-subtitle" style={{ marginTop: 12 }}>상위 라벨(빈도순)</div>
              <div className="label-grid">
                <div className="label-col">
                  <div className="label-head">감정</div>
                  {summary.labels?.emotionsTop?.length ? (
                    <ul className="label-list">
                      {summary.labels.emotionsTop.map(([name, cnt]) => (
                        <li key={`emo-${name}`}><span className="pill">{name}</span><span className="cnt">x{cnt}</span></li>
                      ))}
                    </ul>
                  ) : <div className="muted">없음</div>}
                </div>

                <div className="label-col">
                  <div className="label-head">인지 왜곡</div>
                  {summary.labels?.distortionsTop?.length ? (
                    <ul className="label-list">
                      {summary.labels.distortionsTop.map(([name, cnt]) => (
                        <li key={`dist-${name}`}><span className="pill">{name}</span><span className="cnt">x{cnt}</span></li>
                      ))}
                    </ul>
                  ) : <div className="muted">없음</div>}
                </div>

                <div className="label-col">
                  <div className="label-head">핵심 믿음</div>
                  {summary.labels?.coreTop?.length ? (
                    <ul className="label-list">
                      {summary.labels.coreTop.map(([name, cnt]) => (
                        <li key={`core-${name}`}><span className="pill">{name}</span><span className="cnt">x{cnt}</span></li>
                      ))}
                    </ul>
                  ) : <div className="muted">없음</div>}
                </div>

                <div className="label-col">
                  <div className="label-head">추천 질문</div>
                  {summary.labels?.questionsTop?.length ? (
                    <ul className="label-list">
                      {summary.labels.questionsTop.map(([name, cnt]) => (
                        <li key={`q-${name}`}><span className="pill">{name}</span><span className="cnt">x{cnt}</span></li>
                      ))}
                    </ul>
                  ) : <div className="muted">없음</div>}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <MetricModal open={!!modal} onClose={() => setModal(null)} payload={modal} />
    </div>
  );
}
