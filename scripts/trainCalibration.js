#!/usr/bin/env node
/**
 * scripts/trainCalibration.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 역할
 *  - Firestore의 메시지/피드백을 모아 전역/개인 캘리브레이션 파라미터(Platt 또는 Isotonic)를 학습.
 *  - 결과를 users/{uid}/profile/calibration 문서에 저장(전역은 모든 유저에 공통, 개인은 각 유저별).
 *
 * 사용 예
 *  - 전역(모든 유저 데이터 합산) Platt 학습 후 배포:
 *      node scripts/trainCalibration.js --global --method platt --days 30
 *  - 특정 유저 개인 학습(이소토닉 자동 선택):
 *      node scripts/trainCalibration.js --uid <UID> --method auto --days 60 --min-samples 20
 *  - 전역 + 개인을 한 번에(권장 운영: 전역→개인 순):
 *      node scripts/trainCalibration.js --global --method auto --days 30
 *      node scripts/trainCalibration.js --all-personal --method auto --days 60 --min-samples 20
 *
 * 메서드
 *  - platt  : 로지스틱 회귀(Platt scaling)
 *  - isotonic: PAV(단조 회귀)
 *  - auto   : ECE/Brier 비교로 더 나은 쪽 선택
 */

const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const { admin, db } = require('../backend/firebaseAdmin');

const argv = yargs(hideBin(process.argv))
  .option('uid', { type: 'string', desc: '개인 학습 대상 UID' })
  .option('all-personal', { type: 'boolean', desc: '모든 유저 개인 학습' })
  .option('global', { type: 'boolean', desc: '전역 학습/배포' })
  .option('days', { type: 'number', default: 30, desc: '최근 N일 데이터 사용' })
  .option('from', { type: 'string', desc: 'YYYY-MM-DD (우선순위: from/to > days)' })
  .option('to', { type: 'string', desc: 'YYYY-MM-DD' })
  .option('method', { type: 'string', default: 'auto', choices: ['platt', 'isotonic', 'auto'] })
  .option('min-samples', { type: 'number', default: 20, desc: '개인 보정 활성화 최소 표본' })
  .option('dry-run', { type: 'boolean', desc: '저장하지 않고 결과만 출력' })
  .demandOption(['method'], 'method는 필수입니다.')
  .check((a) => {
    if (!a.global && !a.uid && !a['all-personal']) {
      throw new Error('하나 이상 지정: --global 또는 --uid 또는 --all-personal');
    }
    return true;
  })
  .help().argv;

/* ───────── 날짜 헬퍼 ───────── */
function ymd(d){ return new Date(d).toISOString().slice(0,10); }
function addDays(d, k){ const x = new Date(d); x.setUTCDate(x.getUTCDate()+k); return x; }
function rangeFromArgs(a){
  const now = new Date();
  if (a.from && a.to) return { from: new Date(a.from+'T00:00:00Z'), to: new Date(a.to+'T23:59:59Z') };
  const to = now;
  const from = addDays(now, -Math.max(1, a.days));
  return { from, to };
}

/* ───────── 데이터 적재 ─────────
 * messages 컬렉션 구조: users/{uid}/sessions/{dateKey}/conversations/{cid}/messages/{mid}
 * - role == 'user' 인 문서만 사용
 * - fields:
 *   · analysisSnapshot_v1.confidences._final_raw : 예측확률(보정 전)
 *   · analysisSnapshot_v1.hf.*                  : HF 지표 (엔트로피/엔테일/컨트라딕트)
 *   · message.userScore (1..5) 또는 별도 feedback 저장소 (여기선 message에 있다고 가정)
 */
async function loadDataset({ uid, from, to }) {
  // Firestore collectionGroup 쿼리
  let q = db.collectionGroup('messages')
    .where('role', '==', 'user')
    .where('createdAt', '>=', from)
    .where('createdAt', '<=', to);

  if (uid) q = q.where('uid', '==', uid);

  const snap = await q.get();
  const rows = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    const snapV1 = d.analysisSnapshot_v1 || {};
    const conf = snapV1.confidences || {};
    const hf = snapV1.hf || {};
    const createdAt = d.createdAt?.toDate?.() || null;

    // p: 보정 전 _final_raw (없으면 스킵)
    const p = Number(conf?._final_raw);
    if (!Number.isFinite(p)) return;

    // y: 라벨
    let y = null;
    const score = Number(d.userScore ?? d.feedbackScore);
    if (Number.isFinite(score)) {
      y = score >= 4 ? 1 : 0;
    } else {
      const entail = Number(hf?.nli?.core?.entail ?? 0);
      const contradict = Number(hf?.nli?.core?.contradict ?? 0);
      const entropy = Number(hf?.emotion?.entropy ?? 1);
      y = (entail - contradict >= 0.15) && (entropy <= 0.65) ? 1 : 0;
    }
    rows.push({ p: Math.max(0, Math.min(1, p)), y, createdAt, uid: d.uid || uid || 'unknown' });
  });
  return rows;
}

/* ───────── Metric ───────── */
function brierScore(ds) {
  const n = ds.length || 1;
  return ds.reduce((s, r) => s + Math.pow(r.p - r.y, 2), 0) / n;
}
function ece(ds, bins = 10) {
  const arr = Array.from({ length: bins }, () => ({ n:0, p:0, y:0 }));
  ds.forEach(({p,y}) => {
    let b = Math.min(bins-1, Math.floor(p * bins));
    arr[b].n++; arr[b].p += p; arr[b].y += y;
  });
  let sum = 0, tot = 0;
  arr.forEach(b => {
    if (!b.n) return;
    const avgP = b.p / b.n, avgY = b.y / b.n;
    sum += b.n * Math.abs(avgP - avgY);
    tot += b.n;
  });
  return tot ? sum / tot : 0;
}

/* ───────── Platt 학습(로지스틱) ─────────
 * 간단 SGD. 학습 안정 위해 작은 L2 적용.
 */
function trainPlatt(ds, { lr=0.1, iters=2000, l2=1e-3 }) {
  let a = 1, b = 0; // 초기값
  function sigmoid(z){ return 1/(1+Math.exp(-z)); }

  for (let t=0;t<iters;t++){
    let ga=0, gb=0;
    for (const {p,y} of ds) {
      const z = a * p + b;
      const pred = sigmoid(z);
      const err = (pred - y);
      ga += err * p;
      gb += err;
    }
    // L2
    ga += l2 * a;
    gb += l2 * b;

    a -= lr * ga / ds.length;
    b -= lr * gb / ds.length;
  }
  return { a, b };
}

/* ───────── Isotonic(PAV) ───────── */
function trainIsotonic(ds) {
  // 정렬
  const xs = ds.slice().sort((u,v)=>u.p-v.p).map(r => ({ p:r.p, y:r.y, w:1 }));
  // pool-adjacent-violators
  for (let i=0;i<xs.length;i++){
    xs[i].avg = xs[i].y / xs[i].w;
    while (i>0 && xs[i-1].avg > xs[i].avg) {
      const a=xs[i-1], b=xs[i];
      const nw = a.w + b.w;
      const ny = a.y + b.y;
      xs.splice(i-1, 2, { p:b.p, y:ny, w:nw, avg: ny/nw });
      i--;
    }
  }
  // bins/map 구성(등분할)
  const B = 10;
  const bins = Array.from({length:B+1}, (_,i)=> i/B);
  const map = [];
  for (let i=0;i<B;i++){
    const lo = bins[i], hi = bins[i+1];
    const seg = xs.filter(r => r.p >= lo && r.p < hi);
    if (!seg.length) {
      // 인접 평균 보간
      const prev = map[i-1] ?? 0;
      map.push(prev);
    } else {
      const w = seg.reduce((s,r)=>s+r.w,0);
      const y = seg.reduce((s,r)=>s+r.y,0);
      map.push(y/w);
    }
  }
  return { bins, map };
}

/* ───────── 학습/선택 ───────── */
function calibrate(ds, method='auto'){
  if (ds.length < 5) return { type:'none', model:null, metrics:{ n: ds.length } };

  // 원본 메트릭
  const base = { brier: brierScore(ds), ece: ece(ds), n: ds.length };

  const out = { base };
  let best = { type:'base', brier: base.brier, ece: base.ece, model:null };

  // Platt
  if (method === 'platt' || method === 'auto') {
    const pl = trainPlatt(ds, {});
    const dsPl = ds.map(({p,y}) => {
      const z = pl.a * p + pl.b; const q = 1/(1+Math.exp(-z));
      return { p:q, y };
    });
    const m = { brier: brierScore(dsPl), ece: ece(dsPl), n: ds.length };
    out.platt = { params: pl, metrics: m };
    if (m.brier <= best.brier) best = { type:'platt', model:pl, brier:m.brier, ece:m.ece };
  }

  // Isotonic
  if (method === 'isotonic' || method === 'auto') {
    const iso = trainIsotonic(ds);
    const dsIso = ds.map(({p,y}) => {
      const B=iso.bins.length-1; let b=Math.min(B-1, Math.floor(p*B));
      const q = iso.map[b];
      return { p:q, y };
    });
    const m = { brier: brierScore(dsIso), ece: ece(dsIso), n: ds.length };
    out.isotonic = { params: iso, metrics: m };
    if (m.brier < best.brier - 1e-6) best = { type:'isotonic', model:iso, brier:m.brier, ece:m.ece };
  }

  return { type: best.type, model: best.model, metrics: best, detail: out };
}

/* ───────── 저장 ───────── */
async function upsertGlobal(model){
  const ref = db.collection('users').doc('_GLOBAL_').collection('profile').doc('calibration');
  const body = (model.type === 'platt')
    ? { global: { platt: model.model } }
    : (model.type === 'isotonic')
      ? { global: { isotonic: model.model } }
      : { global: admin.firestore.FieldValue.delete() };

  await ref.set({ ...body, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log('[OK] wrote GLOBAL calibration profile -> users/_GLOBAL_/profile/calibration');
}

async function upsertPersonal(uid, model, n, minSamples){
  const ref = db.collection('users').doc(String(uid)).collection('profile').doc('calibration');
  const body = (model.type === 'platt')
    ? { personal: { platt: model.model, rated_samples: n, min_samples: minSamples } }
    : (model.type === 'isotonic')
      ? { personal: { isotonic: model.model, rated_samples: n, min_samples: minSamples } }
      : { personal: admin.firestore.FieldValue.delete() };

  await ref.set({ ...body, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log(`[OK] wrote PERSONAL calibration for uid=${uid} (n=${n})`);
}

/* ───────── 메인 ───────── */
(async ()=>{
  const { from, to } = rangeFromArgs(argv);

  if (argv.global) {
    // 전유저 데이터 합산
    const snap = await db.collectionGroup('messages')
      .where('role', '==', 'user')
      .where('createdAt', '>=', from)
      .where('createdAt', '<=', to)
      .get();

    const ds = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      const s = d.analysisSnapshot_v1 || {};
      const conf = s.confidences || {};
      const hf = s.hf || {};
      const p = Number(conf?._final_raw);
      if (!Number.isFinite(p)) return;

      let y = null;
      const score = Number(d.userScore ?? d.feedbackScore);
      if (Number.isFinite(score)) y = score >= 4 ? 1 : 0;
      else {
        const entail = Number(hf?.nli?.core?.entail ?? 0);
        const contradict = Number(hf?.nli?.core?.contradict ?? 0);
        const entropy = Number(hf?.emotion?.entropy ?? 1);
        y = (entail - contradict >= 0.15) && (entropy <= 0.65) ? 1 : 0;
      }
      ds.push({ p: Math.max(0, Math.min(1,p)), y });
    });

    if (!ds.length) {
      console.log('[INFO] no samples for global.');
    } else {
      const model = calibrate(ds, argv.method);
      console.log('[INFO] global metrics:', model.metrics);
      if (!argv['dry-run']) await upsertGlobal(model);
    }
  }

  if (argv.uid) {
    const ds = await loadDataset({ uid: argv.uid, from, to });
    if (ds.length < argv['min-samples']) {
      console.log(`[INFO] uid=${argv.uid} not enough samples: n=${ds.length}, need >= ${argv['min-samples']}`);
    } else {
      const model = calibrate(ds, argv.method);
      console.log(`[INFO] personal metrics(uid=${argv.uid}):`, model.metrics);
      if (!argv['dry-run']) await upsertPersonal(argv.uid, model, ds.length, argv['min-samples']);
    }
  }

  if (argv['all-personal']) {
    const users = await db.collection('users').get();
    for (const doc of users.docs) {
      const uid = doc.id;
      if (uid === '_GLOBAL_') continue;
      const ds = await loadDataset({ uid, from, to });
      if (ds.length < argv['min-samples']) {
        console.log(`[SKIP] uid=${uid} n=${ds.length} < min=${argv['min-samples']}`);
        continue;
      }
      const model = calibrate(ds, argv.method);
      console.log(`[INFO] personal metrics(uid=${uid}):`, model.metrics);
      if (!argv['dry-run']) await upsertPersonal(uid, model, ds.length, argv['min-samples']);
    }
  }

  process.exit(0);
})().catch(e => {
  console.error('[ERR]', e);
  process.exit(1);
});
