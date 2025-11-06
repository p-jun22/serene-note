#!/usr/bin/env node
/* scripts/dumpCalibration.js
 * - users/{uid}/profile/calibration 문서를 덤프한다.
 * - 출력 스키마는 gptService가 기대하는 최신 형식:
 *   { "uid": { "global": {...}, "personal": {...}, "updatedAt": ... }, ... }
 *
 * 사용 예)
 *   # 특정 UID만
 *   node scripts/dumpCalibration.js --uid <UID> --out calib.json
 *   # 모든 유저
 *   node scripts/dumpCalibration.js --all --out calib_all.json
 *   # 파일 없이 STDOUT으로
 *   node scripts/dumpCalibration.js --uid <UID>
 */
const fs = require('fs');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const { admin, db } = require('../backend/firebaseAdminbaseAdmin');

const argv = yargs(hideBin(process.argv))
  .option('uid', { type: 'string', desc: '대상 UID' })
  .option('all', { type: 'boolean', desc: '모든 유저 덤프' })
  .option('out', { type: 'string', desc: '저장 경로(생략 시 STDOUT)' })
  .check(a => {
    if (!a.uid && !a.all) throw new Error('--uid 또는 --all 필요');
    return true;
  })
  .help().argv;

async function readOne(uid) {
  const ref = db.collection('users').doc(String(uid))
    .collection('profile').doc('calibration');
  const snap = await ref.get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  // 스키마 방어적 클린업
  const out = {};
  if (d.global && (d.global.platt || d.global.isotonic)) out.global = d.global;
  if (d.personal && (d.personal.platt || d.personal.isotonic)) {
    out.personal = {
      ...d.personal,
      // 숫자 보정
      rated_samples: Number(d.personal.rated_samples ?? 0),
      min_samples: Number(d.personal.min_samples ?? 20),
    };
  }
  if (d.updatedAt?.toDate) out.updatedAt = d.updatedAt.toDate().toISOString();
  return out;
}

(async () => {
  const result = {};
  if (argv.uid) {
    const one = await readOne(argv.uid);
    if (one) result[argv.uid] = one;
  } else if (argv.all) {
    const us = await db.collection('users').get();
    for (const doc of us.docs) {
      const uid = doc.id;
      const one = await readOne(uid);
      if (one) result[uid] = one;
    }
  }
  const json = JSON.stringify(result, null, 2);
  if (argv.out) {
    fs.writeFileSync(argv.out, json);
    console.log(`[OK] wrote ${argv.out}`);
  } else {
    console.log(json);
  }
  process.exit(0);
})().catch(e => { console.error('[ERR]', e); process.exit(1); });
