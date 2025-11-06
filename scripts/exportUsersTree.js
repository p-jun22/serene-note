// scripts/exportUsersTree.js
// users 컬렉션 전체 + 모든 서브컬렉션을 재귀적으로 덤프
// 타입 보존 직렬화(Timestamp/GeoPoint/DocRef/Bytes) + 메타(path/create/update)

// # 전체 users 트리 → users_full_tree.json
// node scripts/exportUsersTree.js

// # 특정 uid만 (쉼표 구분)
// node scripts/exportUsersTree.js --only=UID_A,UID_B --out=partial_users.json


const fs = require('fs');
const path = require('path');

// 프로젝트의 firebase-admin 초기화를 재사용
const { admin, db } = require('../backend/firebaseAdmin');

const TS = admin.firestore.Timestamp;
const GP = admin.firestore.GeoPoint;

// ----- 값 직렬화: 사람이 읽기 좋은 JSON으로 변환 -----
function serializeValue(v) {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;

  // Timestamp
  if (v instanceof TS) {
    return {
      __type: 'timestamp',
      iso: v.toDate().toISOString(),
      _seconds: v.seconds,
      _nanoseconds: v.nanoseconds,
    };
  }
  // GeoPoint
  if (v instanceof GP) {
    return {
      __type: 'geopoint',
      latitude: v.latitude,
      longitude: v.longitude,
    };
  }
  // DocumentReference
  if (v instanceof admin.firestore.DocumentReference) {
    return {
      __type: 'docref',
      path: v.path,
    };
  }
  // Bytes/Blob
  if (v && (v.constructor?.name === 'Bytes' || v.constructor?.name === 'Blob')) {
    // toBase64()는 Admin SDK Bytes에 존재
    const b64 = typeof v.toBase64 === 'function' ? v.toBase64() : Buffer.from(v.toUint8Array?.() || []).toString('base64');
    return {
      __type: 'bytes',
      base64: b64,
    };
  }

  // 배열
  if (Array.isArray(v)) return v.map(serializeValue);

  // 객체
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      // Firestore에는 undefined가 없지만, 혹시 모를 undefined는 null로 떨어뜨림
      out[k] = (val === undefined) ? null : serializeValue(val);
    }
    return out;
  }

  // 함수/심볼 등은 문자열화
  return String(v);
}

// ----- 문서 하나 직렬화(+ 메타데이터 & 서브컬렉션) -----
async function dumpDoc(docSnap) {
  const data = docSnap.data() || {};
  const serialized = serializeValue(data);

  // 메타
  const meta = {
    id: docSnap.id,
    path: docSnap.ref.path,
    createTime: docSnap.createTime ? serializeValue(docSnap.createTime) : null,
    updateTime: docSnap.updateTime ? serializeValue(docSnap.updateTime) : null,
    readTime: docSnap.readTime ? serializeValue(docSnap.readTime) : null,
  };

  // 서브컬렉션
  const subOut = {};
  const subCols = await docSnap.ref.listCollections();
  // 병렬 처리
  await Promise.all(
    subCols.map(async (subCol) => {
      subOut[subCol.id] = await dumpCollection(subCol);
    })
  );

  return {
    __meta: meta,
    __data: serialized,
    __subcollections: subOut,
  };
}

// ----- 컬렉션 재귀 덤프 -----
async function dumpCollection(colRef) {
  const snap = await colRef.get();
  const rows = [];
  for (const doc of snap.docs) {
    rows.push(await dumpDoc(doc));
  }
  return rows;
}

// ----- 엔트리포인트: users 전체 트리 덤프 -----
async function main() {
  // 옵션: 특정 uid만 덤프하고 싶으면 --only=<uid> (콤마로 다수 가능)
  // 파일 경로 변경은 --out=파일명.json
  const args = Object.fromEntries(process.argv.slice(2).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ''), true];
  }));

  const onlyList = typeof args.only === 'string' ? args.only.split(',').map(s => s.trim()).filter(Boolean) : null;
  const outFile = args.out ? String(args.out) : path.resolve(process.cwd(), 'users_full_tree.json');

  const usersCol = db.collection('users');
  let usersSnap;

  if (onlyList && onlyList.length) {
    // 지정된 uid들만
    const docs = [];
    for (const uid of onlyList) {
      const docRef = usersCol.doc(uid);
      const docSnap = await docRef.get();
      if (docSnap.exists) docs.push(docSnap);
    }
    usersSnap = { docs };
  } else {
    usersSnap = await usersCol.get();
  }

  const out = [];
  for (const doc of usersSnap.docs) {
    out.push(await dumpDoc(doc));
  }

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[export] ${out.length} user doc(s) → ${outFile}`);
}

main().catch((e) => {
  console.error('[export] failed:', e);
  process.exit(1);
});
