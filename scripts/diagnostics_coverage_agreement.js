// scripts/diagnostics_coverage_agreement.js
// ─────────────────────────────────────────────────────────────────────────────
// [목적]
// - 길이-버킷 커버리지 테스트:
//   · 버킷: 토큰수 0–50 / 50–150 / 150–300 / 300+
//   · (a) 핵심믿음 비율(≠공란), (b) HF-NLI (entail−contradict) 평균/분산,
//     (c) HF 엔트로피 평균
// - HF→LLM 일관성(agreement) 곡선:
//   · x = 1 - HF entropy, y = LLM confidences.emotions, Pearson r 상관
//
// [원칙]
// - 프론트는 Firestore 직접 접근 금지 → Admin SDK로만 읽기
// - 스키마/키/경로 불변: users/{uid}/sessions/{dateKey}/conversations/{cid}/messages/{mid}
// - role == 'user' 메시지만 사용(assistant에는 snapshot/hf_raw 저장 금지)
// - 결과를 /public/results/diagnostics_YYYYMMDD_HHmmss.json 로 저장
//
// [실행 예]
// node scripts/diagnostics_coverage_agreement.js --from=2025-10-01 --to=2025-10-20 --uids=Dcg0P...,oO4I6y...
// ─────────────────────────────────────────────────────────────────────────────

// dotenv은 선택(없어도 경고만 내고 진행)
try { require('dotenv').config(); } catch (e) {
  console.warn('[warn] dotenv not found, skipping .env load');
}

const fs = require('fs');
const path = require('path');

// backend/firebaseAdmin.js 단일 초기화 사용
const { db, admin } = require('../backend/firebaseAdmin');
const Timestamp = admin.firestore.Timestamp;

// ---------------------------
// CLI 파라미터 파싱
// ---------------------------
const args = process.argv.slice(2).reduce((acc, a) => {
  const [k, v] = a.split('=');
  acc[k.replace(/^--/, '')] = v ?? true;
  return acc;
}, {});

// 날짜 파라미터(YYYY-MM-DD)
const fromStr = args.from;
const toStr = args.to;
if (!fromStr || !toStr) {
  console.error('[ERR] --from=YYYY-MM-DD --to=YYYY-MM-DD 는 필수입니다.');
  process.exit(1);
}
const uidsFilter = (args.uids || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const useAllUids = uidsFilter.length === 0;

// ---------------------------
// 날짜 → Timestamp 범위
// ---------------------------
function toDateAtStartKST(ymd) {
  return new Date(`${ymd}T00:00:00.000Z`);
}
function toDateAfterEndKST(ymd) {
  return new Date(`${ymd}T23:59:59.999Z`);
}
const startTs = Timestamp.fromDate(toDateAtStartKST(fromStr));
const endTs = Timestamp.fromDate(toDateAfterEndKST(toStr));

// ---------------------------
// 토큰 카운터 준비(tiktoken 우선)
// ---------------------------
let enc = null;
let encodingName = 'cl100k_base'; // gpt-4o 계열 호환
async function initTokenizer() {
  try {
    const { encoding_for_model } = await import('@dqbd/tiktoken');
    enc = encoding_for_model(encodingName);
    console.log(`[info] tiktoken 사용: ${encodingName}`);
  } catch (e) {
    console.warn('[warn] tiktoken 사용 불가 → 간이 토큰 추정으로 대체');
  }
}
function countTokens(text) {
  if (!text) return 0;
  if (enc) {
    try { return enc.encode(text).length; } catch { /* no-op */ }
  }
  // fallback: 거친 추정
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  const chars = String(text).length;
  return Math.round(words + (chars / 4) * 0.3);
}

// ---------------------------
// 스키마 안전 추출 유틸
// ---------------------------
function pickSnapshotFields(snap = {}) {
  const coreBeliefs = Array.isArray(snap.coreBeliefs) ? snap.coreBeliefs : [];
  const hasCore = coreBeliefs.some(s => (s || '').trim().length > 0);

  const hf = snap.hf || {};
  const hfEmotion = hf.emotion || {};
  const hfNliCore = (hf.nli && hf.nli.core) || {};

  let hfEntropy = typeof hfEmotion.entropy === 'number' ? hfEmotion.entropy : undefined;
  let entail = typeof hfNliCore.entail === 'number' ? hfNliCore.entail : undefined;
  let contradict = typeof hfNliCore.contradict === 'number' ? hfNliCore.contradict : undefined;

  let llmConfEmo = undefined;
  if (snap.llm && snap.llm.confidences && typeof snap.llm.confidences.emotions === 'number') {
    llmConfEmo = snap.llm.confidences.emotions;
  } else if (snap.confidences && typeof snap.confidences.emotions === 'number') {
    llmConfEmo = snap.confidences.emotions;
  }

  const hfRaw = snap.hf_raw || {};
  if (hfEntropy === undefined && typeof hfRaw.emotion_entropy === 'number') {
    hfEntropy = hfRaw.emotion_entropy;
  }
  if (entail === undefined && hfRaw.nli_core && typeof hfRaw.nli_core.entail === 'number') {
    entail = hfRaw.nli_core.entail;
  }
  if (contradict === undefined && hfRaw.nli_core && typeof hfRaw.nli_core.contradict === 'number') {
    contradict = hfRaw.nli_core.contradict;
  }

  return {
    hasCore,
    hfEntropy, // number | undefined
    nliDelta: (Number.isFinite(entail) && Number.isFinite(contradict))
      ? (entail - contradict) : undefined,
    llmConfEmo // number | undefined
  };
}

// ---------------------------
// 통계 유틸
// ---------------------------
function mean(arr) {
  const v = arr.filter(x => Number.isFinite(x));
  if (v.length === 0) return undefined;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function variance(arr) {
  const v = arr.filter(x => Number.isFinite(x));
  if (v.length < 2) return undefined;
  const m = mean(v);
  const sse = v.reduce((a, x) => a + Math.pow(x - m, 2), 0);
  return sse / (v.length - 1);
}
function pearson(xArr, yArr) {
  const x = [], y = [];
  for (let i = 0; i < xArr.length; i++) {
    const xi = xArr[i], yi = yArr[i];
    if (Number.isFinite(xi) && Number.isFinite(yi)) {
      x.push(xi); y.push(yi);
    }
  }
  const n = x.length;
  if (n < 2) return { n: 0, r: undefined };
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return { n, r: denom === 0 ? undefined : (num / denom) };
}

// ---------------------------
// 버킷 정의
// ---------------------------
const buckets = [
  { key: '0-50',    min: 0,   max: 50 },
  { key: '50-150',  min: 51,  max: 150 },
  { key: '150-300', min: 151, max: 300 },
  { key: '300+',    min: 301, max: Infinity },
];
function bucketKeyForTokens(t) {
  for (const b of buckets) {
    if (t >= b.min && t <= b.max) return b.key;
  }
  return '300+';
}

// ---------------------------
// 메시지 읽기(컬렉션 그룹)
// ---------------------------
async function fetchUserMessages() {
  const snap = await db.collectionGroup('messages')
    .where('role', '==', 'user')
    .where('createdAt', '>=', startTs)
    .where('createdAt', '<=', endTs)
    .get();

  const docs = [];
  snap.forEach(d => {
    const refPath = d.ref.path; // users/UID/sessions/DATE/conversations/CID/messages/MID
    const m = refPath.match(/^users\/([^/]+)\//);
    const uid = m ? m[1] : null;
    if (!uid) return;
    if (!useAllUids && !uidsFilter.includes(uid)) return;

    const row = d.data() || {};
    const snapV1 = row.analysisSnapshot_v1 || {};
    const text = row.text || row.content || '';
    docs.push({ uid, id: d.id, text, snapshot: snapV1 });
  });
  return docs;
}

// ---------------------------
// 메인
// ---------------------------
(async function main() {
  await initTokenizer();

  console.log(`[run] from=${fromStr}, to=${toStr}, uids=${useAllUids ? '(ALL)' : uidsFilter.join(',')}`);

  const rows = await fetchUserMessages();
  const scanned = rows.length;
  console.log(`[info] scanned user messages: ${scanned}`);

  const agg = {
    '0-50':   { n: 0, cores: 0, nli: [], hfEntropies: [] },
    '50-150': { n: 0, cores: 0, nli: [], hfEntropies: [] },
    '150-300':{ n: 0, cores: 0, nli: [], hfEntropies: [] },
    '300+':   { n: 0, cores: 0, nli: [], hfEntropies: [] },
  };

  const agreeHFConf = [];
  const agreeLLMEmo = [];
  const samplePairs = [];

  let used = 0;

  for (const r of rows) {
    const tokens = countTokens(r.text || '');
    const bkey = bucketKeyForTokens(tokens);

    const { hasCore, hfEntropy, nliDelta, llmConfEmo } = pickSnapshotFields(r.snapshot);

    agg[bkey].n += 1;
    if (hasCore) agg[bkey].cores += 1;
    if (Number.isFinite(nliDelta)) agg[bkey].nli.push(nliDelta);
    if (Number.isFinite(hfEntropy)) agg[bkey].hfEntropies.push(hfEntropy);

    if (Number.isFinite(hfEntropy) && Number.isFinite(llmConfEmo)) {
      const hfConf = 1 - hfEntropy;
      agreeHFConf.push(hfConf);
      agreeLLMEmo.push(llmConfEmo);
      if (samplePairs.length < 100) samplePairs.push([hfConf, llmConfEmo]);
    }

    used += 1;
  }

  const bucketsOut = {};
  for (const b of buckets) {
    const k = b.key;
    const A = agg[k];
    const coreBeliefFillRate = A.n === 0 ? 0 : (A.cores / A.n);
    const nliDeltaMean = mean(A.nli);
    const nliDeltaVar  = variance(A.nli);
    const hfEntropyMean = mean(A.hfEntropies);
    bucketsOut[k] = {
      n: A.n,
      coreBeliefFillRate,
      nliDeltaMean,
      nliDeltaVar,
      hfEntropyMean,
    };
  }

  const { n: nPairs, r: pearsonR } = pearson(agreeHFConf, agreeLLMEmo);
  const meanHFConf = mean(agreeHFConf);
  const meanLLMEmo = mean(agreeLLMEmo);

  const runId = `diag_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
  const out = {
    ok: true,
    runId,
    from: fromStr,
    to: toStr,
    uids: useAllUids ? 'ALL' : uidsFilter,
    counts: { scanned, used },
    buckets: bucketsOut,
    agreement: {
      nPairs,
      pearsonR,
      meanHFConf,
      meanLLMEmo,
      samplePairs
    }
  };

  const outDir = path.resolve(__dirname, '../public/results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `diagnostics_${new Date().toISOString().replace(/[:]/g, '-').slice(0,19)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');

  console.log('[done] saved:', outPath);
  console.table(Object.entries(bucketsOut).map(([k, v]) => ({
    bucket: k,
    n: v.n,
    coreFill: v.coreBeliefFillRate?.toFixed?.(3),
    nliMean: v.nliDeltaMean?.toFixed?.(3),
    nliVar: v.nliDeltaVar?.toFixed?.(3),
    hfEntMean: v.hfEntropyMean?.toFixed?.(3),
  })));
  console.log(`[agreement] nPairs=${nPairs}, pearsonR=${pearsonR?.toFixed?.(3)}, meanHFConf=${meanHFConf?.toFixed?.(3)}, meanLLMEmo=${meanLLMEmo?.toFixed?.(3)}`);
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
