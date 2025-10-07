const express = require('express');
const router = express.Router();
const { db } = require('../firebase');

router.post('/', async (req, res) => {
  const { uid, input, score, response, timestamp } = req.body;

  try {
    await db
      .collection('user_feedback')
      .doc(uid)
      .collection('entries')
      .add({
        input,
        userScore: score,
        ...response,
        timestamp,
      });

    res.status(200).json({ message: '저장 완료' });
  } catch (err) {
    console.error('Firestore 저장 오류:', err);
    res.status(500).json({ error: '저장 실패' });
  }
});

module.exports = router;
