// src/api.js
import axios from "axios";
import { auth } from "./firebase";

const api = axios.create({
  baseURL: "http://localhost:5000/api",
  withCredentials: false,
  timeout: 15000,
});

// Firebase ID 토큰을 매 요청에 첨부
api.interceptors.request.use(async (config) => {
  const user = auth.currentUser;
  if (user) {
    try {
      const token = await user.getIdToken();
      config.headers.Authorization = `Bearer ${token}`;
    } catch (e) {
      // 토큰 못 붙여도 요청은 진행 (백엔드에서 401 처리)
    }
  }
  return config;
});

export default api;
