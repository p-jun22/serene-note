// backend/app.js
// Express + Firebase Admin + CORS
// 제공 API:
//  - GET  /api/emotions?from&to
//  - GET  /api/calendar?startDateKey&endDateKey
//  - GET  /api/calendar/:dateKey
//  - POST /api/messages   (서버 권위 저장/집계용; 프론트 Firestore와 병행 가능)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const { authMiddleware } = require('./middlewares/authMiddleware');
const repo = require('./services/firestoreRepository');

const app = express();

// 프론트 axios baseURL: http://localhost:5000/api  (프론트 코드 참고)
// -> 여기서는 /api 경로로 마운트
app.use(cors({ origin: ['http://localhost:3000'], credentials: true }));
app.use(bodyParser.json({ limit: '1mb' }));


const gptRoute = require('./routes/gptRoute');
const router = express.Router();
// GPT 분석 라우트
router.use('/gpt', gptRoute);

// -------------------------
// 건강 체크
router.get('/health', (req, res) => res.json({ ok: true }));

// -------------------------
// 캘린더 집계
// 반환 형식: { "YYYY-MM-DD": { count: number, topEmoji: string } }
router.get('/calendar', authMiddleware, async (req, res) => {
  try {
    const { startDateKey, endDateKey } = req.query;
    if (!startDateKey || !endDateKey) {
      return res.status(400).json({ error: 'startDateKey, endDateKey are required' });
    }
    const uid = req.user.uid;

    const conversations = await repo.listConversationsByDateRange(uid, startDateKey, endDateKey);

    // 날짜별: 대화 개수, 가장 많이 등장한 이모지(또는 최신값)
    const map = {}; // dateKey -> { count, emojiCount: {emoji: n} }
    for (const c of conversations) {
      const dateKey = c.dateKey;
      if (!dateKey) continue;
      map[dateKey] ||= { count: 0, emojiCount: {} };
      map[dateKey].count += 1;

      if (c.moodEmoji) {
        map[dateKey].emojiCount[c.moodEmoji] = (map[dateKey].emojiCount[c.moodEmoji] || 0) + 1;
      }
    }

    const out = {};
    for (const [dateKey, v] of Object.entries(map)) {
      // 최빈 이모지 선정
      const entries = Object.entries(v.emojiCount);
      entries.sort((a, b) => b[1] - a[1]);
      out[dateKey] = {
        count: v.count,
        topEmoji: entries.length ? entries[0][0] : ''
      };
    }

    return res.json(out);
  } catch (e) {
    console.error('GET /calendar error', e);
    return res.status(500).json({ error: 'calendar aggregation failed' });
  }
});

// 날짜에 기록 존재 여부
router.get('/calendar/:dateKey', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const dateKey = req.params.dateKey;
    const exists = await repo.existsConversationOn(uid, dateKey);
    return res.json({ exists });
  } catch (e) {
    console.error('GET /calendar/:dateKey error', e);
    return res.status(500).json({ error: 'calendar day check failed' });
  }
});

// -------------------------
// 감정 그래프 데이터
// 반환 형식: [{ dateKey, emotions: ["슬픔","불안", ...] }, ...]
router.get('/emotions', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from, to are required (YYYY-MM-DD)' });
    }

    const conversations = await repo.listConversationsByDateRange(uid, from, to);

    const byDate = new Map(); // dateKey -> [emotions...]
    for (const c of conversations) {
      const arr = Array.isArray(c.moodLabels) ? c.moodLabels.filter(Boolean) : [];
      if (!c.dateKey) continue;
      if (!byDate.has(c.dateKey)) byDate.set(c.dateKey, []);
      byDate.get(c.dateKey).push(...arr);
    }

    const out = Array.from(byDate.entries()).map(([dateKey, emotions]) => ({
      dateKey,
      emotions
    }));

    return res.json({ data: out });
  } catch (e) {
    console.error('GET /emotions error', e);
    return res.status(500).json({ error: 'emotions aggregation failed' });
  }
});

// -------------------------
// 서버 권위 저장(옵션) — 프론트에서 보낸 메시지/스냅샷 기록
router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { sessionId, conversationId, message } = req.body || {};
    if (!sessionId || !conversationId || !message) {
      return res.status(400).json({ error: 'sessionId, conversationId, message are required' });
    }

    await repo.appendMessage(uid, sessionId, conversationId, message);

    // 대화 문서가 없을 수 있으니 최소 필드 보정(프론트에서 이미 작성하지만 안전장치)
    if (message.analysisSnapshot_v1?.emotions?.length || message.analysisSnapshot_v1?.coreBeliefs?.length) {
      await repo.upsertConversation(uid, {
        id: conversationId,
        dateKey: sessionId,
        updatedAt: Date.now(),
        // moodEmoji는 프론트(ChatBot)에서 계산/저장하지만, 없으면 추정 가능
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /messages error', e);
    return res.status(500).json({ error: 'append message failed' });
  }
});

app.use('/api', router);

// 서버 시작
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Serene Note API running on http://localhost:${PORT}/api`);
});
