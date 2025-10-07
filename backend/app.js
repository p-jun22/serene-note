// backend/app.js
// ─────────────────────────────────────────────────────────────
// [역할]
// - Express 부트스트랩: CORS, JSON 파서, 라우터 바인딩, 헬스체크
// - Firebase Admin 초기화는 여기서 하지 않는다(합의 사항).
//   필요한 모듈(authMiddleware, firestoreRepository 등)에서
//   backend/firebaseAdmin.js 단일 초기화 모듈을 import한다.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

/* ---------------------------
   CORS: 요청 Origin 에코 + Credentials 허용
   (withCredentials=true 대응, '*' 금지)
--------------------------- */
function isAllowedOrigin(origin) {
  if (!origin) return true; // 서버-서버, curl 등
  try {
    const u = new URL(origin);
    const { host, protocol, hostname } = u;
    if (!/^https?:$/.test(protocol)) return false;

    // 로컬/사설망/개발 터널 도메인들 허용
    if (/^localhost(?::\d+)?$/i.test(host)) return true;
    if (/^127\.0\.0\.1(?::\d+)?$/i.test(host)) return true;
    if (hostname === '::1') return true;
    if (/\.local(?::\d+)?$/i.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?$/i.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?$/i.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(?::\d+)?$/i.test(host)) return true;
    if (/\.asse\.devtunnels\.ms$/i.test(host)) return true;
    if (/\.app\.github\.dev$/i.test(host)) return true;
    if (/githubpreview\.dev$/i.test(host)) return true;

    return false;
  } catch {
    return false;
  }
}

// 프리플라이트 우선 처리
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] || 'Authorization, Content-Type, Accept, Origin, X-Requested-With'
      );
      res.setHeader(
        'Access-Control-Allow-Methods',
        req.headers['access-control-request-method'] || 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      );
      return res.sendStatus(204);
    }
    return res.sendStatus(403);
  }
  next();
});

// 본요청 CORS 처리(Origin 에코)
app.use((req, res, next) =>
  cors({ origin: (o, cb) => cb(null, isAllowedOrigin(o) ? o : false), credentials: true })(req, res, next)
);

// JSON 파서
app.use(express.json({ limit: '2mb' }));

// 라우터 로드(여기서만 장착; 핸들러는 routes/api.js에만)
let apiRouter;
try {
  apiRouter = require('./routes/api');
  console.log('[boot] routes/api loaded');
} catch (e) {
  console.error('[boot] routes/api load failed:', e);
  process.exit(1);
}
app.use('/api', require('./routes/api'));

// 무인증 핑(헬스 체크)
app.get('/ping', (_req, res) => res.json({ ok: true, pong: true }));

// 전역 예외 로깅
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

// 리슨 시작
app.listen(PORT, '0.0.0.0', () => {
  console.log('[backend] listening on', PORT);
});
