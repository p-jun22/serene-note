#!/usr/bin/env node
/* scripts/computeMetrics.js
 * -----------------------------------------------------------------------------
 * 역할
 *  - users/{uid}/feedback/*에서 (p, y) 쌍을 모아 EM(정확도), F1 계산
 *  - y(정답라벨) = (ratings.useful >= posRating) 또는 (rating >= posRating)
 *  - p(예측확률) = model.p_final_raw 우선, 없으면 HF 신호로 폴백
 *  - 옵션으로 전역/개인 Platt 보정 적용 가능
 *
 * 사용 예
 *  - 특정 유저: node scripts/computeMetrics.js --uid <UID>
 *  - 모든 유저 합산: node scripts/computeMetrics.js --all
 *  - 임계값/평가기준 변경: --threshold 0.5 --pos-rating 4
 *  - Platt 보정 적용: --apply-calibration
 * -----------------------------------------------------------------------------
 */

const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const { admin, db } = require('../backend/firebaseAdmin');

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function toNumber(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/* 라벨(y) 선택: ratings.useful → rating → useful 순 */
function pickRating(row) {
  if (!row || typeof row !== 'object') return null;
  const nested = row.ratings && toNumber(row.ratings.useful, null);
  if (nested != null) return nested;
  const flat = toNumber(row.rating, null);
  if (flat != null) return flat;
  const loose = toNumber(row.useful, null);
  if (loose != null) return loose;
  return null;
}

/* 확률(p) 선택: p_final_raw → HF 기반 폴백 */
function pickProbability(model = {}) {
  const pFinal = toNumber(model.p_final_raw, null);
  if (pFinal != null) return clamp01(pFinal);

  // 폴백: HF 신호로 합성
  // emotions ~= 1 - hf_entropy, core ~= max(0, entail - contradict), distort ~= p_distortions || 0.5
  const hfEntropy = clamp01(toNumber(model.hf_entropy, 0.5));
  const entail = clamp01(toNumber(model.hf_entail, 0.0));
  const contradict = clamp01(toNumber(model.hf_contradict, 0.0));
  const emotions = clamp01(1 - hfEntropy);
  const core = clamp01(entail - contradict);
  const distort = clamp01(toNumber(model.p_distortions, 0.5));
  const p = (emotions + core + distort) / 3;
  return clamp01(p);
}

/* Platt 적용 */
function applyPlatt(p, a, b) {
  const x = clamp01(p);
  const z = a * x + b;
  return 1 / (1 + Math.exp(-z));
}

/* 개인/전역 보정 로드: personal 우선(표본 충족 시), 아니면 global */
async function loadCalibrationForUid(uid) {
  // 개인
  let personal = null;
  try {
    const pSnap = await db.collection('users').doc(String(uid))
      .collection('profile').doc('calibration').get();
    personal = pSnap.exists ? (pSnap.data() || {}) : null;
  } catch { personal = null; }

  // 전역 (우리 운영 스키마: users/_GLOBAL_/profile/calibration)
  let global = null;
  try {
    const gSnap = await db.collection('users').doc('_GLOBAL_')
      .collection('profile').doc('calibration').get();
    global = gSnap.exists ? (gSnap.data() || {}) : null;
  } catch { global = null; }

  // 사용 결정
  let use = null;
  if (personal && personal.platt && Number.isFinite(personal.rated_samples) && Number.isFinite(personal.min_samples)) {
    if (personal.rated_samples >= personal.min_samples) {
      use = { scope: 'personal', platt: personal.platt };
    }
  }
  if (!use && global && global.platt) {
    use = { scope: 'global', platt: global.platt };
  }
  return use; // null이면 보정 미적용
}

/* 메트릭 계산 */
function computeMetrics(ps, ys, threshold = 0.5) {
  const n = Math.max(1, ps.length);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const y = ys[i];
    const pred = p >= threshold ? 1 : 0;
    if (pred === 1 && y === 1) tp++;
    else if (pred === 1 && y === 0) fp++;
    else if (pred === 0 && y === 1) fn++;
    else tn++;
  }
  const em = (tp + tn) / n; // exact match / accuracy
  const f1 = (2 * tp) / (2 * tp + fp + fn || 1); // 분모 0 보호
  return { em, f1, confusion: { tp, fp, fn, tn } };
}

/* 피드백 로드 */
async function loadFeedbackRows(uid) {
  const col = db.collection('users').doc(String(uid)).collection('feedback');
  const snap = await col.get();
  const out = [];
  snap.forEach(doc => out.push({ _id: doc.id, ...(doc.data() || {}) }));
  return out;
}

/* 메인 */
(async () => {
  const argv = yargs(hideBin(process.argv))
    .option('uid', { type: 'string', desc: '대상 사용자 UID' })
    .option('all', { type: 'boolean', desc: '모든 사용자 합산' })
    .option('threshold', { type: 'number', default: 0.5, desc: '양성 예측 임계값' })
    .option('pos-rating', { type: 'number', default: 4, desc: 'ratings.useful ≥ pos-rating → 양성' })
    .option('apply-calibration', { type: 'boolean', default: false, desc: 'Platt 보정 적용' })
    .demandOption([], '옵션을 지정하세요. 예: --uid <UID> 또는 --all')
    .help()
    .argv;

  if (!argv.uid && !argv.all) {
    console.error('ERROR: --uid <UID> 또는 --all 중 하나를 지정하세요.');
    process.exit(1);
  }

  const uids = [];
  if (argv.uid) {
    uids.push(argv.uid);
  } else {
    const us = await db.collection('users').get();
    us.forEach(d => uids.push(d.id));
  }

  const ps = [];
  const ys = [];
  const stats = { samples: 0, pos: 0, neg: 0 };
  const usedCal = {};

  for (const oneUid of uids) {
    const rows = await loadFeedbackRows(oneUid);
    let cal = null;
    if (argv['apply-calibration']) {
      cal = await loadCalibrationForUid(oneUid);
      if (cal?.platt) usedCal[oneUid] = { scope: cal.scope, a: cal.platt.a, b: cal.platt.b };
    }
    for (const r of rows) {
      const rating = pickRating(r);
      if (rating == null) continue; // 라벨 없는 표본은 스킵
      const y = rating >= argv['pos-rating'] ? 1 : 0;

      const p0 = pickProbability(r.model || {});
      const p = (argv['apply-calibration'] && cal?.platt)
        ? applyPlatt(p0, Number(cal.platt.a), Number(cal.platt.b))
        : p0;

      ps.push(p);
      ys.push(y);
      stats.samples++;
      if (y === 1) stats.pos++; else stats.neg++;
    }
  }

  const { em, f1, confusion } = computeMetrics(ps, ys, argv.threshold);
  const scope = argv.uid ? `user:${argv.uid}` : 'all-users';

  const out = {
    scope,
    n: stats.samples,
    pos: stats.pos,
    neg: stats.neg,
    threshold: argv.threshold,
    posRating: argv['pos-rating'],
    calibrationApplied: argv['apply-calibration'] ? usedCal : null,
    confusion,
    metrics: { em: Number(em.toFixed(4)), f1: Number(f1.toFixed(4)) }
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch(err => {
  console.error('[ERR]', err?.message || err);
  process.exit(1);
});
