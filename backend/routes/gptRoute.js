const express = require('express');
const router = express.Router();
const { runCBTAnalysis } = require('../services/gptService');

router.post('/', async (req, res) => {
    const { input } = req.body;
    try {
        const result = await runCBTAnalysis(input);
        res.json(result);
    } catch (err) {
        console.error('GPT 호출 에러:', err);
        res.status(500).json({ error: '서버 에러가 발생했습니다.' });
    }
});

module.exports = router;
