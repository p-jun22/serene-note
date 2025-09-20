// backend/routes/gptRoute.js
const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middlewares/authMiddleware');
const { runCBTAnalysis } = require('../services/gptService');

// POST /api/gpt  { input }
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { input } = req.body || {};
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input is required' });
    }

    // 1) LLM 분석
    const out = await runCBTAnalysis(input);
    const { 감정 = [], 인지왜곡 = [], 핵심믿음 = '', 추천질문 = '' } = out || {};

    // 2) (발표안 기준) 점수 필드는 null 유지 (총점 폐지)
    const schemaScore = null;
    const consistencyScore = null;
    const totalScore = null;

    res.json({
      감정, 인지왜곡, 핵심믿음, 추천질문,
      schemaScore, consistencyScore, totalScore
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
