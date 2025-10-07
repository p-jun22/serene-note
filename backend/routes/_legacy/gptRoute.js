// backend/routes/gptRoute.js
const express = require('express');
const { runGptAnalysis } = require('../services/gptService');
const { validateFirebaseIdToken } = require('../middlewares/authMiddleware');
const router = express.Router();

// LLM 1차 분석, CBT JSON 출력
router.post('/', validateFirebaseIdToken, async (req, res) => {
  try {
    const { text, lang, dateKey } = req.body;
    if (!text || !lang || !dateKey)
      return res.status(400).json({ error: 'text, lang, dateKey required' });

    // LLM 분석 (OpenAI, LangChain 등)
    const llmResult = await runGptAnalysis({ text, lang, dateKey });

    // 핵심 JSON 스키마 보장
    const {
      emotions = [],
      distortions = [],
      coreBeliefs = [],
      recommendedQuestions = [],
      llmConfidence = null
    } = llmResult;

    res.json({
      emotions,
      distortions,
      coreBeliefs,
      recommendedQuestions,
      llmConfidence
    });
  } catch (error) {
    console.error('GPT 분석 오류:', error);
    res.status(500).json({ error: 'GPT 분석 실패' });
  }
});

module.exports = router;
