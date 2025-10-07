// routes/analysisRoute.js
const express = require('express');
const router = express.Router();

// 기존 GPT 1차 분석 그대로 재사용 (HF 서버 없이도 동작)
const { runCBTAnalysis } = require('../services/gptService');

// 헬스체크: Node 서버 살아있음 여부 (HF는 아직 안 붙였으니 false로 고정)
router.get('/health', (_req, res) => {
  return res.json({ node: true, hf: false });
});

// 메인 분석 엔드포인트(임시):
// 지금은 GPT 1차 분석 결과만 반환하고, 지표/판정은 더미로 둔다.
// 이후 HF 연동되면 여기서 zero-shot/NLI 호출 + 지표/판정 계산을 추가할 것.
router.post('/', async (req, res) => {
  const { input } = req.body;
  if (!input || !input.trim()) {
    return res.status(400).json({ error: 'input is required' });
  }

  try {
    const gpt = await runCBTAnalysis(input);

    // 임시 결정 규칙(더미): 아직 HF 검증이 없으므로 REVIEW로 고정
    // 나중에 HF 붙이면 PASS/REVIEW/ASK 규칙형으로 교체
    return res.json({
      decision: 'REVIEW',
      reason: ['HF 검증 미연결(임시 모드)'],
      followup: null,
      gpt,
      metrics: {
        confidence: null,
        agreement: null,
        nli: null,
        conformalK: null,
        hfTopEmotions: [],
        hfTopDistortions: []
      }
    });
  } catch (err) {
    console.error('analysis (temporary) error:', err);
    return res.status(500).json({ error: 'analysis failed' });
  }
});

module.exports = router;
