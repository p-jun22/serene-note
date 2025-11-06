#!/usr/bin/env node
// scripts/evalHoldout.js
const yargs = require('yargs'); const { hideBin } = require('yargs/helpers');
const { admin, db } = require('../backend/firebaseAdmin');

const argv = yargs(hideBin(process.argv))
  .option('uid',  { type:'string', demandOption:true, desc:'홀드아웃 대상 UID' })
  .option('from', { type:'string', desc:'YYYY-MM-DD' })
  .option('to',   { type:'string', desc:'YYYY-MM-DD' })
  .option('bins', { type:'number', default:10, desc:'ECE bin 수(권장 8~10)' })
  .option('out',  { type:'string', desc:'결과 JSON 파일 경로(선택)' })
  .option('tag',  { type:'string', desc:'실험 태그(선택)' })
  .option('persist', { type:'boolean', desc:'결과를 Firestore에 기록(experiments/calibration/evals)' })
  .help().argv;

function rangeFromArgs(a){
  const now = new Date();
  if (a.from && a.to) return { from:new Date(a.from+'T00:00:00Z'), to:new Date(a.to+'T23:59:59Z') };
  return { from:new Date(now - 7*864e5), to:now };
}
const { from, to } = rangeFromArgs(argv);

function sigmoid(z){ return 1/(1+Math.exp(-z)); }
function brier(ds){ return ds.length ? ds.reduce((s,r)=>s+(r.p-r.y)**2,0)/ds.length : NaN; }
function ece(ds,B=10){
  if (!ds.length) return NaN;
  const buckets = Array.from({length:B}, ()=>[]);
  for (const r of ds) {
    const b = Math.min(B-1, Math.floor(r.p * B));
    buckets[b].push(r);
  }
  let tot = ds.length, sum = 0;
  for (const bucket of buckets) {
    if (!bucket.length) continue;
    const avgP = bucket.reduce((s,r)=>s+r.p,0)/bucket.length;
    const avgY = bucket.reduce((s,r)=>s+r.y,0)/bucket.length;
    sum += (bucket.length/tot) * Math.abs(avgP - avgY);
  }
  return sum;
}

async function loadGlobalCal(){
  const snap = await db.doc('users/_GLOBAL_/profile/calibration').get();
  const g = snap.data()?.global || {};
  if (g.platt)    return { type:'platt',    a:g.platt.a, b:g.platt.b };
  if (g.isotonic) return { type:'isotonic', bins:g.isotonic.bins, map:g.isotonic.map };
  return { type:'none' };
}
function applyCal(p, cal){
  if (cal.type === 'platt')    return sigmoid(cal.a*p + cal.b);
  if (cal.type === 'isotonic'){ const B=cal.bins.length-1; const b=Math.min(B-1, Math.floor(p*B)); return cal.map[b]; }
  return p;
}

async function buildFeedbackMap(uid){
  const out = new Map();
  const fb = await db.collection('users').doc(uid).collection('feedback').get();
  fb.forEach(d=>{
    const v = d.data() || {};
    const cid = v.conversationId;
    const useful = Number(v?.ratings?.useful);
    if (cid && Number.isFinite(useful)) out.set(String(cid), useful);
  });
  return out;
}
function getConvIdFromMessageDoc(doc){ // .../conversations/{cid}/messages/{mid}
  return doc.ref.parent.parent.id;
}

(async()=>{
  console.log(`[eval] uid=${argv.uid} window=${from.toISOString()}~${to.toISOString()}`);

  // 전역 보정 맵 로드
  const cal = await loadGlobalCal();

  // 라벨 맵 준비(일반 유저 규칙: 4·5→1, 1~3→0)
  const fbMap = await buildFeedbackMap(argv.uid);

  // 홀드아웃 메시지 적재 (인덱스: role+uid+createdAt)
  const snap = await db.collectionGroup('messages')
    .where('role','==','user')
    .where('uid','==',argv.uid)
    .where('createdAt','>=',from)
    .where('createdAt','<=',to)
    .get();

  const base = [], post = [];
  snap.forEach(doc=>{
    const d = doc.data() || {};
    const s = d.analysisSnapshot_v1 || {};
    const conf = s.confidences || {};
    const p = Number(conf?._final_raw);
    if (!Number.isFinite(p)) return;

    const cid = getConvIdFromMessageDoc(doc);
    const useful = fbMap.get(String(cid));
    if (!Number.isFinite(useful)) return;          // 라벨 없는 건 제외
    const y = (useful >= 4) ? 1 : 0;               // qwer는 일반 유저

    base.push({ p, y });
    post.push({ p: applyCal(p, cal), y });
  });

  // ---- 통계는 "반드시" 여기서 먼저 계산 ----
  const n   = base.length;
  const pos = base.reduce((s,r)=>s+r.y,0);
  const gtPre  = base.filter(r=>r.p  > 0.5).length;
  const gtPost = post.filter(r=>r.p > 0.5).length;

  const bB = brier(base), eB = ece(base, argv.bins);
  const bA = brier(post), eA = ece(post, argv.bins);

  const report = {
    run_id: new Date().toISOString(),
    uid: argv.uid,
    tag: argv.tag || null,
    window: { from: from.toISOString(), to: to.toISOString() },
    bins: argv.bins,
    n, positives: pos,
    thresh_pre_0_5: gtPre,
    thresh_post_0_5: gtPost,
    base:       { brier: bB, ece: eB },
    calibrated: {
      type: cal.type,
      params: (cal.type==='platt') ? { a: cal.a, b: cal.b }
            : (cal.type==='isotonic') ? { bins: cal.bins, map: cal.map } : null,
      brier: bA, ece: eA
    },
    deltas: { brier: bA - bB, ece: eA - eB }
  };

  console.log(JSON.stringify(report, null, 2));

  // 파일 저장 옵션
  if (argv.out) {
    const fs = require('fs'); const path = require('path');
    fs.mkdirSync(path.dirname(argv.out), { recursive: true });
    fs.writeFileSync(argv.out, JSON.stringify(report, null, 2));
    console.log('[OK] wrote', argv.out);
  }

  // Firestore에 결과 남기기(선택)
  if (argv.persist) {
    await db.collection('experiments').doc('calibration')
      .collection('evals').add(report);
    console.log('[OK] persisted to experiments/calibration/evals');
  }

  process.exit(0);
})().catch(e=>{ console.error(e); process.exit(1); });
