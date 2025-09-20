// routes/strengthAnalysisRoute.js
const express = require('express');
const axios = require('axios');
const router = express.Router();

const HF_BASE = process.env.HF_BASE_URL || 'http://127.0.0.1:5001';

// 헬스체크: Flask(HF) 살아있는지
router.get('/strength/health', async (_req, res) => {
  try {
    const r = await axios.get(`${HF_BASE}/health`, { timeout: 5000 });
    return res.json({ ok: true, hf: r.data?.ok === true });
  } catch (e) {
    return res.json({ ok: true, hf: false });
  }
});

// 강점 분석: Node → Flask로 uid 전달 (Flask가 Firebase Admin으로 읽음)
router.post('/analyze-strength', async (req, res) => {
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid is required' });

  try {
    const r = await axios.post(`${HF_BASE}/analyze-strength`, { uid }, { timeout: 30000 });
    return res.json(r.data);
  } catch (err) {
    console.error('analyze-strength proxy error:', err?.response?.data || err.message);
    const status = err?.response?.status || 500;
    return res.status(status).json({ error: 'flask_call_failed', detail: err?.response?.data || null });
  }
});

module.exports = router;