// frontend/src/api.js
// [Axios 인스턴스 - 프런트의 유일한 네트워크 진입점]
// - 모든 API 호출은 이 인스턴스로만 나간다.
// - Firebase ID 토큰을 Authorization 헤더에 자동 첨부한다.
// - HF 서버 호출은 백엔드가 한다. 프런트는 /api/* 만 호출한다.

import axios from 'axios';
import { auth } from './firebase';

/** 백엔드 baseURL 추론 */
function guessApiBase() {
  const fromEnv = process.env.REACT_APP_API_BASE;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const url = new URL(window.location.href);
  const { protocol, hostname, host } = url;

  // VSCode Remote Tunnels: -3000. → -5000.
  if (/-3000\./.test(host)) return `${protocol}//${host.replace(/-3000\./, '-5000.')}`;

  // 로컬/사설망: 3000 → 5000
  const isPrivate =
    /^localhost$/i.test(hostname) ||
    /^127\.0\.0\.1$/i.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/i.test(hostname) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/i.test(hostname);
  if (isPrivate) return `${protocol}//${hostname}:5000`;

  // 배포/프록시: 동일 호스트로 가정
  return `${protocol}//${host}`;
}

const api = axios.create({
  baseURL: `${guessApiBase()}/api`,
  withCredentials: true,
});

// 요청 인터셉터: Firebase ID 토큰 자동 첨부
api.interceptors.request.use(async (config) => {
  const u = auth.currentUser;
  if (u) {
    const token = await u.getIdToken();
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 응답 인터셉터: 401 → 토큰 갱신 후 1회 재시도
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const { config, response } = err || {};
    if (response?.status === 401 && config && !config._retried) {
      config._retried = true;
      try {
        const u = auth.currentUser;
        if (u) await u.getIdToken(true);
        return api(config);
      } catch (_) {}
    }
    return Promise.reject(err);
  }
);

export default api;
