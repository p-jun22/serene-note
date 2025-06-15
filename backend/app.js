const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// 라우터 불러오기
const gptRoute = require('./routes/gptRoute');
const scoreRoute = require('./routes/scoreRoute'); // 🔥 반드시 추가

const huggingfaceRoute = require('./routes/huggingfaceRoute');
app.use('/api/huggingface', huggingfaceRoute);


// 라우터 등록
app.use('/api/gpt', gptRoute);
app.use('/api/score', scoreRoute); // 🔥 반드시 등록

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));