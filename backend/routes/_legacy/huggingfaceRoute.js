const express = require('express');
const axios = require('axios');
const router = express.Router();

router.post('/', async (req, res) => {
  const { input } = req.body;

  try {
    const response = await axios.post('http://localhost:5001/analyze', { input });
    res.json(response.data);
  } catch (err) {
    console.error('HuggingFace 서버 호출 실패:', err.message);
    res.status(500).json({ error: 'HuggingFace 연동 실패' });
  }
});

module.exports = router;
