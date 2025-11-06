#!/usr/bin/env node
/* scripts/seedCalibration.js
 * ==============================================================================

 * 역할
 *  - gptService.js가 기대하는 최신 스키마에 맞춰 캘리브레이션 프로필을 저장한다.
 *  - 경로: users/{uid}/profile/calibration
 *  - 스키마:
 *    {
 *      "global":   { "platt": { "a": number, "b": number } }  // 또는 "isotonic": { bins, map }
 *      "personal": { "platt": { "a": number, "b": number }, "rated_samples": number, "min_samples": number }
 *    }
 *
 * 사용 예
 *  - 모든 유저에 전역 Platt(a,b) 배포:
 *      node scripts/seedCalibration.js --all --global-platt 0.95,-0.10
 *  - 특정 유저에 개인 Platt(a,b) + 표본수 설정:
 *      node scripts/seedCalibration.js --uid <UID> --personal-platt 1.02,-0.08 --rated 27 --min 20
 *  - 전역은 Platt, 개인은 이소토닉으로(파일로 bins/map 주입):
 *      node scripts/seedCalibration.js --uid <UID> --global-platt 0.98,-0.06 --personal-isotonic ./iso_personal.json --rated 25 --min 20
 *  - 전역/개인 각각 제거:
 *      node scripts/seedCalibration.js --uid <UID> --clear-global
 *      node scripts/seedCalibration.js --uid <UID> --clear-personal
 *
 * 주의
 *  - Admin SDK로 직접 Firestore에 씀(로컬/관리자 환경에서 실행).
 *  - firebaseAdmin 모듈 경로가 다르면 아래 require 경로를 맞춰야 함.
 *  - gptService.js는 "platt"가 있으면 우선 사용, 없으면 "isotonic" 사용.
 *  - personal은 rated_samples >= min_samples일 때만 적용됨(서비스 로직).
 */

const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');

// 프로젝트의 Admin SDK 초기화 모듈
const { admin, db } = require('../backend/firebaseAdmin');
const FieldValue = admin.firestore.FieldValue;

/* ───────── 파서 유틸 ───────── */
function parsePlatt(str) {
  // "0.95,-0.10" → { a:0.95, b:-0.10 }
  if (!str) return null;
  const parts = String(str).split(',').map(s => Number(s.trim()));
  if (parts.length !== 2 || parts.some(v => !Number.isFinite(v))) {
    throw new Error(`--platt 형식 오류: "a,b" 형태여야 합니다. 입력: ${str}`);
  }
  return { a: parts[0], b: parts[1] };
}
function parseIsotonic(jsonFile) {
  if (!jsonFile) return null;
  const p = path.resolve(process.cwd(), jsonFile);
  if (!fs.existsSync(p)) throw new Error(`이소토닉 파일을 찾을 수 없습니다: ${p}`);
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(obj.bins) || !Array.isArray(obj.map) || obj.bins.length !== obj.map.length + 1) {
    throw new Error('isotonic 포맷 오류: { bins:[...], map:[...] } 이고 bins.length = map.length + 1 이어야 합니다.');
  }
  return { bins: obj.bins, map: obj.map };
}

/* ───────── CLI 옵션 ───────── */
const argv = yargs(hideBin(process.argv))
  .option('uid',   { type: 'string', desc: '대상 사용자 UID (여러 명이면 --all)' })
  .option('all',   { type: 'boolean', desc: '모든 users/* 문서에 적용' })

  .option('global-platt',    { type: 'string', desc: '전역 Platt 계수 "a,b"' })
  .option('global-isotonic', { type: 'string', desc: '전역 Isotonic JSON 파일 경로' })
  .option('clear-global',    { type: 'boolean', desc: '전역 보정 제거' })

  .option('personal-platt',    { type: 'string', desc: '개인 Platt 계수 "a,b"' })
  .option('personal-isotonic', { type: 'string', desc: '개인 Isotonic JSON 파일 경로' })
  .option('rated',             { type: 'number', desc: 'personal.rated_samples 값' })
  .option('min',               { type: 'number', desc: 'personal.min_samples 값 (기본 20 추천)' })
  .option('clear-personal',    { type: 'boolean', desc: '개인 보정 제거' })

  .option('dry-run', { type: 'boolean', desc: '실제로 쓰지 않고 결과만 출력' })
  .demandOption([], '옵션을 지정하세요. 예: --all --global-platt 0.95,-0.10')
  .help()
  .argv;

/* ───────── Seed 로직 ───────── */
function buildPayloadFromArgs(argv) {
  const payload = {};
  // 전역
  if (argv.clearGlobal) {
    payload.global = admin.firestore.FieldValue.delete();
  } else {
    const gPlatt = parsePlatt(argv['global-platt']);
    const gIso   = parseIsotonic(argv['global-isotonic']);
    if (gPlatt || gIso) {
      payload.global = {};
      if (gPlatt) payload.global.platt = gPlatt;
      if (!gPlatt && gIso) payload.global.isotonic = gIso; // platt 우선
    }
  }
  // 개인
  if (argv.clearPersonal) {
    payload.personal = admin.firestore.FieldValue.delete();
  } else {
    const pPlatt = parsePlatt(argv['personal-platt']);
    const pIso   = parseIsotonic(argv['personal-isotonic']);
    const rated  = Number.isFinite(argv.rated) ? Number(argv.rated) : undefined;
    const minS   = Number.isFinite(argv.min) ? Number(argv.min) : undefined;

    if (pPlatt || pIso || rated !== undefined || minS !== undefined) {
      payload.personal = {};
      if (pPlatt) payload.personal.platt = pPlatt;
      if (!pPlatt && pIso) payload.personal.isotonic = pIso; // platt 우선
      if (rated !== undefined) payload.personal.rated_samples = rated;
      if (minS   !== undefined) payload.personal.min_samples  = minS;
    }
  }

  // 아무 것도 지정 안 했으면 예외
  if (!('global' in payload) && !('personal' in payload)) {
    throw new Error('설정할 내용이 없습니다. (--global-platt / --global-isotonic / --personal-platt / --personal-isotonic / --clear-*)');
  }
  return payload;
}

async function upsertCalibration(uid, body) {
  const ref = db.collection('users').doc(String(uid))
    .collection('profile').doc('calibration');

  const data = {
    ...body,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (argv['dry-run']) {
    console.log(`[DRY] would set profile/calibration for uid=${uid}:`, JSON.stringify(data, null, 2));
    return;
  }
  await ref.set(data, { merge: true });
  console.log(`[OK] set profile/calibration for uid=${uid}`);
}

async function seedForUid(uid, body) {
  await upsertCalibration(uid, body);
}

async function seedForAll(body) {
  const snap = await db.collection('users').get();
  if (snap.empty) {
    console.log('[INFO] no users/* found.');
    return;
  }
  for (const doc of snap.docs) {
    await upsertCalibration(doc.id, body);
  }
}

/* ───────── 실행 ───────── */
(async () => {
  try {
    const body = buildPayloadFromArgs(argv);

    if (argv.uid && argv.all) {
      throw new Error('--uid 와 --all 은 함께 쓸 수 없습니다.');
    }
    if (!argv.uid && !argv.all) {
      throw new Error('--uid <UID> 또는 --all 중 하나를 지정하세요.');
    }

    if (argv.uid) {
      await seedForUid(argv.uid, body);
    } else if (argv.all) {
      await seedForAll(body);
    }
    process.exit(0);
  } catch (err) {
    console.error('[ERR]', err.message || err);
    process.exit(1);
  }
})();
