// src/components/StrengthWeaknessPage.js
// ─────────────────────────────────────────────────────────────────────────────
// - HF 보정 프로필(Platt/Isotonic)을 불러와 LLM 확신도 p→q(원본→보정) 표시
//   · good  → green   (좋음 계열)
//   · warn  → blue    (중간/주의)
//   · bad   → red     (낮음/경고)
//   · info  → yellow  (정보성)
//   · na    → gray    (신호 없음)
// - NLI core_contradict는 "낮을수록 좋음"이므로 색상 판정 시 1 - value 로 반전하여 계산
// - Hooks 호출 순서 준수 / ESLint 대응

// - HF 서버 CORS 허용 필요. 기본: http://localhost:5001
// - 보정 선택 규칙: 개인(표본≥min) 우선 → 전역 → 미적용
// - q 계산은 메시지별 p에 보정 후 평균(q-avg). 없을 때는 p평균에 보정 적용.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase';

// ===== 환경 상수 =====
const HF_BASE = process.env.REACT_APP_HF_BASE || 'http://localhost:5001';

// ===== 날짜 유틸 =====
function ymdKST(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
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

// ===== 분류 규칙(수치→등급) =====
function clamp01(x) { const n = Number(x); if (!Number.isFinite(n)) return 0; return Math.max(0, Math.min(1, n)); }
function classifyLLMConfidence(v) { const x = clamp01(v); if (x >= 0.8) return 'good'; if (x >= 0.55) return 'warn'; return 'bad'; }
function classifyEmotionsAvg(v) { const x = clamp01(v); if (x >= 0.6) return 'good'; if (x >= 0.3) return 'warn'; return 'bad'; }
function classifyNLI(v) { const x = clamp01(v); if (x >= 0.7) return 'good'; if (x >= 0.35) return 'warn'; return 'bad'; }

// --- 엔트로피 정규화 유틸 ---
// HF가 이미 [0,1] 정규화로 보낼 수도 있고(정책: “정규화 엔트로피”),
// 간혹 ln(K) 스케일(>1)로 들어올 수도 있으므로 자동 보정한다.
function entropyNorm(entropy, K = 10) {
  const e = Number(entropy);
  if (!Number.isFinite(e)) return null;
  if (e <= 1.0000001) return Math.max(0, Math.min(1, e));     // 이미 정규화됨
  const Hmax = Math.log(Math.max(2, K));
  if (!(Hmax > 0)) return null;
  return Math.max(0, Math.min(1, e / Hmax));                  // ln(K)로 정규화
}
function classifyEntropy(entropy, K = 10) {
  const norm = entropyNorm(entropy, K);
  const n = Number.isFinite(norm) ? norm : 1; // 값 없으면 가장 불확실 쪽으로
  if (n <= 0.35) return { cls: 'good', norm: n };
  if (n <= 0.65) return { cls: 'warn', norm: n };
  return { cls: 'bad', norm: n };
}

// 등급→텍스트 라벨
function labelForClass(cls) {
  if (cls === 'good') return '좋음';
  if (cls === 'warn') return '보통';
  if (cls === 'bad') return '나쁨';
  if (cls === 'info') return '정보';
  if (cls === 'na') return 'N/A';
  return '파랑';
}

// 등급→CSS 색상 클래스
function colorForClass(cls) {
  if (cls === 'good') return 'green';
  if (cls === 'warn') return 'blue';
  if (cls === 'bad') return 'red';
  if (cls === 'info') return 'yellow';
  if (cls === 'na') return 'gray';
  return 'gray';
}

// ===== HF 톤/보조 판정 =====
function nliNoSignal(hf) {
  const e = Math.abs(hf?.core_entail ?? 0);
  const c = Math.abs(hf?.core_contradict ?? 0);
  return e < 0.05 && c < 0.05;
}
function lowEmotionInfo(hf) {
  const a = hf?.emotions_avg ?? 0;
  const n = entropyNorm(hf?.emotion_entropy, hf?.K || 10) ?? 1;
  return a < 0.25 && n <= 0.60; // 정규화 기준으로 판정
}

// ===== 수치/배열 유틸 =====
function avg(nums) {
  const arr = nums.map(Number).filter((n) => Number.isFinite(n));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ===== 스냅샷 파서 =====
function pullFromRow(row) {
  const snap = row?.analysisSnapshot_v1 || {};
  const llmC = snap?.llm?.confidences || snap?.confidences || {};
  const hfN = snap?.hf || {};
  const hfR = row?.hf_raw || {};
  return {
    // LLM p(원본)
    llm_emotions_p:  num(llmC.emotions),
    llm_dist_p:      num(llmC.distortions),
    llm_core_p:      num(llmC.coreBelief),
    llm_q_p:         num(llmC.question),

    // HF signals (snapshot.hf 우선, 없으면 hf_raw)
    hf_emotions_avg: num(hfN?.emotion?.avg ?? hfR?.emotions_avg ?? hfR?.emotion?.avg),
    hf_entropy:      num(hfN?.emotion?.entropy ?? hfR?.emotion_entropy ?? hfR?.emotion?.entropy),
    hf_entail:       num(hfN?.nli?.core?.entail ?? hfR?.nli_core?.entail ?? hfR?.nli?.core?.entail),
    hf_contradict:   num(hfN?.nli?.core?.contradict ?? hfR?.nli_core?.contradict ?? hfR?.nli?.core?.contradict),
    _raw: row,
  };
}

// ===== 라벨 집계 =====
function pickArr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function pushCount(map, key) { if (!key) return; const k = String(key).trim(); if (!k) return; map[k] = (map[k] || 0) + 1; }
function extractLabelsFromSnapshot(snap = {}) {
  const out = { emotions: [], distortions: [], coreBeliefs: [], questions: [] };
  const llmOut = snap?.llm?.output || {};
  out.emotions =
    pickArr(snap.emotions) || pickArr(llmOut['감정']) || pickArr(llmOut.emotions);
  out.distortions =
    pickArr(snap.distortions) || pickArr(llmOut['인지왜곡']) || pickArr(llmOut.distortions) || [];
  if (Array.isArray(snap.coreBeliefs) && snap.coreBeliefs.length > 0) out.coreBeliefs = snap.coreBeliefs;
  else {
    const core = llmOut['핵심믿음'] ?? llmOut.coreBelief ?? llmOut.core_belief ?? snap.coreBelief ?? null;
    if (core) out.coreBeliefs = [core];
  }
  if (Array.isArray(snap.recommendedQuestions) && snap.recommendedQuestions.length > 0) out.questions = snap.recommendedQuestions;
  else {
    const q = llmOut['추천질문'] ?? llmOut.question ?? null;
    if (q) out.questions = [q];
  }
  return out;
}
function topK(map, k = 6) { return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, k); }

// ===== 보정기 생성(Platt/Isotonic) =====
function makeCalibrator(profile) {
  const personal = profile?.personal || {};
  const global = profile?.global || {};

  const hasPersonal = (personal?.platt || personal?.isotonic) &&
    (Number(personal?.rated_samples || 0) >= Number(personal?.min_samples || 0));

  const use = hasPersonal ? personal : (global || {});
  let mode = 'none';
  let platt = null;
  let iso = null;

  if (use?.platt) {
    platt = { a: Number(use.platt.a), b: Number(use.platt.b) };
    mode = `${hasPersonal ? 'personal' : 'global'}-platt`;
  } else if (use?.isotonic && Array.isArray(use.isotonic.bins) && Array.isArray(use.isotonic.map)) {
    iso = { bins: use.isotonic.bins.map(Number), map: use.isotonic.map.map(Number) };
    mode = `${hasPersonal ? 'personal' : 'global'}-isotonic`;
  }

  function applyPlatt(p) {
    const x = Math.max(0, Math.min(1, Number(p)));
    const z = platt.a * x + platt.b;
    return 1 / (1 + Math.exp(-z));
  }
  function applyIso(p) {
    const x = Math.max(0, Math.min(1, Number(p)));
    const edges = iso.bins, acc = iso.map;
    let lo = 0, hi = edges.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (x < edges[mid]) hi = mid;
      else lo = mid;
    }
    return (acc[lo] ?? x);
  }

  const apply = (p) => {
    if (!Number.isFinite(Number(p))) return null;
    if (platt) return applyPlatt(p);
    if (iso) return applyIso(p);
    return Number(p);
  };

  return { apply, mode, details: { personal, global } };
}

// ===== 설명(모달) =====
function buildExplain(metricKey, value, extra = {}) {
  const K = extra.K || 10;
  const bullets = [];
  let title = ''; let formula = ''; let reason = ''; let improvement = ''; let p = null; let q = null; let mode = null;

  if (value && typeof value === 'object' && ('p' in value || 'q' in value)) {
    p = Number.isFinite(+value.p) ? +value.p : null;
    q = Number.isFinite(+value.q) ? +value.q : null;
    mode = value.mode || null;
  }
  const pqLine = (p != null || q != null) ? `p${p!=null?`=${p.toFixed(2)}`:''}${q!=null?` → q=${q.toFixed(2)}`:''}${mode?`  [${mode}]`:''}` : '';

  const flow = [
    '① 사용자 입력 → LLM 1차 해석(감정/왜곡/핵심/질문 + 확신도 p).',
    '② HF 지표 산출(감정 avg/entropy, NLI entail/contradict).',
    '③ 보정 프로필(개인 우선→전역)로 p→q 보정(Platt/Isotonic).',
    '④ q 기반 요약/표시, 게이팅/코칭은 서비스 규칙에 따름.',
  ].join('\n');

  switch (metricKey) {
    case 'llm_emotions':
      title = `LLM 감정 확신도 ${pqLine}`;
      formula = 'q = σ(a·p + b)  // Platt (개인≥min이면 개인, 아니면 전역)\n또는 q = isotonic(p)  // bins/map 단조 보정';
      reason = '보정으로 과신/과소신 조절, 신뢰도 분포를 현실에 맞춤.';
      improvement = '개인 표본을 늘리면 개인 보정으로 자동 승급.';
      bullets.push('색상 없이 숫자만 표시합니다.');
      break;
    case 'llm_dist':
      title = `LLM 왜곡 확신도 ${pqLine}`;
      formula = '동일(Platt/Isotonic) 방식으로 p→q';
      reason = '왜곡 라벨 일관성 보정.';
      improvement = 'few-shot/라벨 정의 보강 병행.';
      bullets.push('색상 없이 숫자만 표시합니다.');
      break;
    case 'llm_core':
      title = `LLM 핵심믿음 확신도 ${pqLine}`;
      formula = '동일(Platt/Isotonic) 방식으로 p→q';
      reason = '핵심믿음 추출 안정성 보정.';
      improvement = '후보 리스트/선택형 UX로 보조.';
      bullets.push('색상 없이 숫자만 표시합니다.');
      break;
    case 'llm_q':
      title = `LLM 질문 확신도 ${pqLine}`;
      formula = '동일(Platt/Isotonic) 방식으로 p→q';
      reason = '코칭 질문 생성 신뢰도 보정.';
      improvement = '질문 템플릿/의도 슬롯화.';
      bullets.push('색상 없이 숫자만 표시합니다.');
      break;
    case 'hf_emotions_avg': {
      const v = Number.isFinite(+value) ? (+value).toFixed(2) : '-';
      title = `HF emotions_avg (${v}) — 감정 평균 점수`;
      formula = 'LLM 선택 감정 기반 확률 평균(필요 시 합성 로직 적용)';
      reason = '특정 감정으로 수렴할수록 ↑';
      improvement = '라벨 축소/데이터 튜닝.';
      break; }
    case 'hf_entropy': {
      const raw = Number(value);
      const n = entropyNorm(raw, K);
      title = `HF emotion_entropy (${Number.isFinite(raw)?raw.toFixed(2):'-'}) — 정규화 ${Number.isFinite(n)?n.toFixed(2):'-'}`;
      formula = `정규화 규칙: e<=1이면 e(이미 정규화), e>1이면 e/ln(K) (K=${K})`;
      reason = '낮을수록 집중(신뢰 ↑)';
      improvement = '데이터 증강/라벨 가이드.';
      break; }
    case 'hf_entail': {
      const v = Number.isFinite(+value) ? (+value).toFixed(2) : '-';
      title = `HF core_entail (${v}) — NLI 정당화`;
      formula = 'entail = p(entailment | premise, hypothesis)';
      reason = '핵심믿음이 본문으로 정당화되는 정도.';
      improvement = '핵심믿음 문장화/근거 정렬.';
      break; }
    case 'hf_contradict': {
      const v = Number.isFinite(+value) ? (+value).toFixed(2) : '-';
      title = `HF core_contradict (${v}) — NLI 반증(낮을수록 좋음)`;
      formula = 'contradict = p(contradiction | premise, hypothesis)';
      reason = '반증 신호.';
      improvement = '극단화/일반화 완화.';
      break; }
    default:
      title = '지표';
      formula = '-'; reason = '-'; improvement = '-';
  }
  return { title, formula, reason, improvement, bullets, flow };
}

// ===== 칩(색상 계산 고정: 색 이름 클래스만 사용) =====
function ScoreChip({ label, value, cal, kind, onClick, hint, tone, invert = false, noColor = false }) {
  const show = (v) => Number.isFinite(+v) ? (+v).toFixed(2) : '-';
  const text = cal != null ? `${show(value)}→${show(cal)}` : show(value);
  const basis = (cal != null ? cal : value);

  let cls = 'chip';
  const addColor = (level) => { cls += ` ${colorForClass(level)}`; };

  if (!noColor) {
    if (tone) {
      addColor(tone); // tone은 'info' 또는 'na'로 들어옴 → yellow/gray
    } else if (kind === 'llm') {
      // 요청: LLM 칩은 색상 제거 → 패스
    } else if (kind === 'hf-entropy') {
      addColor(classifyEntropy(basis).cls);
    } else if (kind === 'hf-avg') {
      addColor(classifyEmotionsAvg(basis));
    } else if (kind === 'hf-nli') {
      const score = invert ? (1 - clamp01(basis)) : basis; // contradict는 invert=true
      addColor(classifyNLI(score));
    }
  }

  return (
    <button className={cls} onClick={onClick} title={hint || ''}>
      <b>{label}</b><span className="dot">•</span><span>{text}</span>
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

// ===== 진단 빌더 =====
function buildDiagnosis(summary) {
  const items = [];
  if (!summary) return items;
  const { hf, msgCount = 0 } = summary;
  const ent = classifyEntropy(hf.emotion_entropy, hf.K || 10);
  const isNliNA = nliNoSignal(hf);
  const isLowEmoInfo = lowEmotionInfo(hf);

  // (요청) LLM 관련 진단 제거

  // HF emotions_avg
  if (isLowEmoInfo) {
    items.push({ cls: 'info', text: `감정 신호 약함(정보). emotions_avg ${(hf.emotions_avg||0).toFixed(2)}, entropy ${(entropyNorm(hf.emotion_entropy, hf.K||10)??0).toFixed(2)}.` });
  } else {
    const lvl = classifyEmotionsAvg(hf.emotions_avg);
    items.push({ cls: lvl, text: `HF 감정 평균 점수 ${labelForClass(lvl)} (현재 ${(hf.emotions_avg||0).toFixed(2)}).` });
  }

  // 엔트로피
  items.push({ cls: ent.cls, text: `감정 분포 집중도 ${labelForClass(ent.cls)} (정규화 ${(ent.norm||0).toFixed(2)}).` });

  // NLI
  if (isNliNA) items.push({ cls: 'na', text: '핵심믿음 NLI 신호 회색(N/A).' });
  else {
    const entailLvl = classifyNLI(hf.core_entail);
    const contraScore = 1 - clamp01(hf.core_contradict ?? 0); // 낮을수록 좋음 → 반전
    const contraLvl = classifyNLI(contraScore);
    items.push({ cls: entailLvl, text: `핵심믿음 정당화(Entail) ${labelForClass(entailLvl)} (현재 ${(hf.core_entail||0).toFixed(2)}).` });
    items.push({ cls: contraLvl, text: `핵심믿음 반증(Contradict) 낮을수록 좋음 → ${labelForClass(contraLvl)} (현재 ${(hf.core_contradict||0).toFixed(2)}).` });
  }

  // 표본 수
  if (msgCount < 3) items.push({ cls: 'info', text: `메시지 수가 적습니다(${msgCount}개). 평균치 변동성이 클 수 있어요.` });

  return items;
}

// ===== 메인 컴포넌트 =====
export default function StrengthWeaknessPage() {
  const [authed, setAuthed] = useState(false);
  const [uid, setUid] = useState(null);
  const [pivot, setPivot] = useState(toFirstOfMonth(new Date()));
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null);
  const [summary, setSummary] = useState(null);
  const [modal, setModal] = useState(null);

  // 보정 프로필
  const [calib, setCalib] = useState({ mode: 'none', apply: (p)=>p, details: {} });

  // Auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthed(!!u);
      setUid(u?.uid || null);
    });
    return () => unsub();
  }, []);

  // 보정 프로필 로드
  useEffect(() => {
    let aborted = false;
    async function loadProfile() {
      if (!authed || !uid) { setCalib({ mode:'none', apply:(p)=>p, details:{} }); return; }
      try {
        const res = await fetch(`${HF_BASE}/calibration/profile?uid=${encodeURIComponent(uid)}`);
        const data = await res.json();
        if (aborted) return;
        const c = makeCalibrator(data || {});
        setCalib(c);
      } catch {
        setCalib({ mode:'none', apply:(p)=>p, details:{} });
      }
    }
    loadProfile();
    return () => { aborted = true; };
  }, [authed, uid]);

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
      if (!rows.find(r => r.dateKey === active)) setActive(rows[0]?.dateKey || null);
    })().catch(() => setSessions([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivot, authed]);

  // 세션 요약 로드
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

      // LLM p-avg
      const p_emotions = avg(pulled.map(p => p.llm_emotions_p));
      const p_dist     = avg(pulled.map(p => p.llm_dist_p));
      const p_core     = avg(pulled.map(p => p.llm_core_p));
      const p_q        = avg(pulled.map(p => p.llm_q_p));

      // LLM q-avg (메시지별 p→q 후 평균; p가 없으면 null)
      const q_emotions = avg(pulled.map(p => p.llm_emotions_p!=null ? calib.apply(p.llm_emotions_p) : null).filter(v=>v!=null))
        ?? (p_emotions!=null ? calib.apply(p_emotions) : null);
      const q_dist     = avg(pulled.map(p => p.llm_dist_p!=null ? calib.apply(p.llm_dist_p) : null).filter(v=>v!=null))
        ?? (p_dist!=null ? calib.apply(p_dist) : null);
      const q_core     = avg(pulled.map(p => p.llm_core_p!=null ? calib.apply(p.llm_core_p) : null).filter(v=>v!=null))
        ?? (p_core!=null ? calib.apply(p_core) : null);
      const q_q        = avg(pulled.map(p => p.llm_q_p!=null ? calib.apply(p.llm_q_p) : null).filter(v=>v!=null))
        ?? (p_q!=null ? calib.apply(p_q) : null);

      const llm = {
        emotions_p: p_emotions ?? 0.90, emotions_q: q_emotions ?? p_emotions ?? 0.90,
        distortions_p: p_dist ?? 0.80,  distortions_q: q_dist ?? p_dist ?? 0.80,
        core_p: p_core ?? 0.85,         core_q: q_core ?? p_core ?? 0.85,
        q_p: p_q ?? 0.75,               q_q: q_q ?? p_q ?? 0.75,
      };

      const hf = {
        emotions_avg:    avg(pulled.map(p => p.hf_emotions_avg)) ?? 0.28,
        emotion_entropy: avg(pulled.map(p => p.hf_entropy))      ?? 2.26, // >1이면 자동 정규화됨
        core_entail:     avg(pulled.map(p => p.hf_entail))       ?? 1.00,
        core_contradict: avg(pulled.map(p => p.hf_contradict))   ?? 0.00,
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
        emotionsTop:    topK(counts.emotions, 6),
        distortionsTop: topK(counts.distortions, 6),
        coreTop:        topK(counts.coreBeliefs, 6),
        questionsTop:   topK(counts.questions, 6),
      };

      setSummary({
        dateKey: active, convCount, msgCount, llm, hf, labels, hfCount,
        calibMode: calib.mode,
      });
    })().catch(() => {
      setSummary({
        dateKey: active, convCount: 0, msgCount: 0,
        llm: { emotions_p:0.90, emotions_q:0.90, distortions_p:0.80, distortions_q:0.80, core_p:0.85, core_q:0.85, q_p:0.75, q_q:0.75 },
        hf:  { emotions_avg:0.28, emotion_entropy:2.26, core_entail:1.00, core_contradict:0.00, K:10 },
        labels: { emotionsTop: [], distortionsTop: [], coreTop: [], questionsTop: [] },
        hfCount: 0, calibMode: 'none',
      });
    });
  }, [active, authed, calib]);

  const onOpenExplain = (key, payload, extra) => setModal(buildExplain(key, payload, extra));
  const diagnosis = useMemo(() => buildDiagnosis(summary), [summary]);

  // ===== 렌더 =====
  return (
    <div className="page" style={{ width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, width: '100%' }}>
        {/* 상단 헤더 */}
        <div className="toolbar" style={{ gridColumn: '1 / -1', marginBottom: 8 }}>
          <div className="title">계산식, 보정</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn" onClick={() => {
              const d = new Date(pivot); setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() - 1, 1)));
            }} aria-label="이전 달">◀</button>
            <div className="panel" style={{ padding: '6px 10px' }}>{monthLabel(pivot)}</div>
            <button className="btn" onClick={() => {
              const d = new Date(pivot); setPivot(ymdKST(new Date(d.getFullYear(), d.getMonth() + 1, 1)));
            }} aria-label="다음 달">▶</button>

            {/* 보정 상태 표시 (색 이름 클래스 사용) */}
            <span className={`chip ${summary?.calibMode && summary.calibMode!=='none' ? 'green' : 'yellow'}`}>
              보정: {summary?.calibMode || 'none'}
            </span>
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
                    <span className={`chip ${(summary?.hfCount || 0) > 0 ? 'green' : 'yellow'}`}>
                      HF 데이터: {(summary?.hfCount || 0) > 0 ? '정상' : '미수집'}
                    </span>
                  </div>

                  <div className="chips-col">
                    {/* HF */}
                    <div className="muted label">HF</div>
                    {(() => {
                      const toneAvg = lowEmotionInfo(summary.hf) ? 'info' : undefined; // blue
                      const toneNli = nliNoSignal(summary.hf) ? 'na' : undefined;    // gray
                      return (
                        <div className="chip-row">
                          <ScoreChip
                            label="emotions_avg (평균)"
                            value={summary.hf.emotions_avg}
                            kind="hf-avg"
                            tone={toneAvg}
                            onClick={() => onOpenExplain('hf_emotions_avg', summary.hf.emotions_avg)}
                          />
                          <ScoreChip
                            label="emotion_entropy (엔트로피)"
                            value={entropyNorm(summary.hf.emotion_entropy, summary.hf.K || 10)}
                            // 칩에는 정규화된 값 자체를 표시
                            kind="hf-entropy"
                            onClick={() => onOpenExplain('hf_entropy', summary.hf.emotion_entropy, { K: summary.hf.K || 10 })}
                          />
                          <ScoreChip
                            label="core_entail (NLI 정당화)"
                            value={summary.hf.core_entail}
                            kind="hf-nli"
                            tone={toneNli}
                            onClick={() => onOpenExplain('hf_entail', summary.hf.core_entail)}
                          />
                          <ScoreChip
                            label="core_contradict (NLI 반증)"
                            value={summary.hf.core_contradict}
                            kind="hf-nli"
                            invert={true} // 낮을수록 좋음 → 색상 반전
                            tone={toneNli}
                            onClick={() => onOpenExplain('hf_contradict', summary.hf.core_contradict)}
                          />
                        </div>
                      );
                    })()}

                    {/* LLM (p→q) — 요청: 색상 제거(noColor) */}
                    <div className="muted label" style={{ marginTop: 10 }}>LLM</div>
                    <div className="chip-row">
                      <ScoreChip
                        label="감정 (확신도)"
                        value={summary.llm.emotions_p}
                        cal={summary.llm.emotions_q}
                        kind="llm"
                        noColor
                        onClick={() => onOpenExplain('llm_emotions', { p: summary.llm.emotions_p, q: summary.llm.emotions_q, mode: summary.calibMode })}
                      />
                      <ScoreChip
                        label="왜곡 (확신도)"
                        value={summary.llm.distortions_p}
                        cal={summary.llm.distortions_q}
                        kind="llm"
                        noColor
                        onClick={() => onOpenExplain('llm_dist', { p: summary.llm.distortions_p, q: summary.llm.distortions_q, mode: summary.calibMode })}
                      />
                      <ScoreChip
                        label="핵심믿음 (확신도)"
                        value={summary.llm.core_p}
                        cal={summary.llm.core_q}
                        kind="llm"
                        noColor
                        onClick={() => onOpenExplain('llm_core', { p: summary.llm.core_p, q: summary.llm.core_q, mode: summary.calibMode })}
                      />
                      <ScoreChip
                        label="질문 (확신도)"
                        value={summary.llm.q_p}
                        cal={summary.llm.q_q}
                        kind="llm"
                        noColor
                        onClick={() => onOpenExplain('llm_q', { p: summary.llm.q_p, q: summary.llm.q_q, mode: summary.calibMode })}
                      />
                    </div>
                  </div>
                </div>

                {/* 간단 진단 */}
                <div>
                  <div className="panel-subtitle">간단 진단</div>
                  <ul className="diagnosis">
                    {diagnosis.map((d, i) => {
                      const label = labelForClass(d.cls);
                      const colorCls = colorForClass(d.cls);
                      return (
                        <li key={i} className={colorCls}>
                          <span className={`diag-badge ${colorCls}`}>{label}</span>
                          <span>{d.text}</span>
                        </li>
                      );
                    })}
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
