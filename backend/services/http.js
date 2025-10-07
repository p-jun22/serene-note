// backend/services/http.js
// [역할]
// - axios 공통 인스턴스 생성 및 표준화된 요청/응답/에러 처리
// - HF 서버 등 외부 서비스 호출에 공통 사용
//
// [핵심]
// - 기본 타임아웃/헤더/베이스URL/에러 포맷 통일
// - 요청/응답 인터셉터로 로깅 및 에러 정규화
// - (선택) HF 토큰 헤더 자동 주입

const axios = require('axios');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 15000);

// 환경변수
const HF_SERVER = process.env.HF_SERVER || '';               // 예: http://127.0.0.1:5001
const HF_TOKEN  = process.env.HF_TOKEN  || '';               // 있으면 Bearer 자동 주입

// 공통 에러 포맷터 (에러 객체를 일관된 형태로 변환)
function normalizeAxiosError(error) {
  const status  = error?.response?.status ?? null;
  const data    = error?.response?.data ?? null;
  const code    = error?.code ?? null;
  const message = error?.message || 'request_failed';
  return { status, code, message, data };
}

// 공통 인스턴스 생성 헬퍼
function createAxios({ baseURL = '', timeout = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const instance = axios.create({
    baseURL,
    timeout,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    // 필요 시 proxy, httpsAgent 등 추가
  });

  // 요청 인터셉터: 요청 ID/로그/토큰
  instance.interceptors.request.use((config) => {
    // 요청 식별자(로깅/추적용)
    config.headers['X-Request-Id'] = config.headers['X-Request-Id'] || crypto.randomUUID();

    // HF 토큰 자동 주입(해당 인스턴스가 HF 용이라면)
    if (HF_TOKEN && baseURL && baseURL === HF_SERVER) {
      config.headers['Authorization'] = `Bearer ${HF_TOKEN}`;
    }

    // 개발 시 간단 로깅 (원하면 주석 처리)
    if (process.env.NODE_ENV !== 'production') {
      // 콘솔 너무 시끄러우면 아래 한 줄 주석
      // console.log('[HTTP]', config.method?.toUpperCase(), config.baseURL || '', config.url);
    }
    return config;
  });

  // 응답 인터셉터: 그대로 통과
  instance.interceptors.response.use(
    (res) => res,
    (err) => {
      // 에러를 정규화해서 throw
      throw normalizeAxiosError(err);
    }
  );

  return instance;
}

// 외부(HF 등) 호출용 인스턴스
const httpExternal = createAxios({
  baseURL: HF_SERVER || undefined,
});

// 필요하면 내부 API용/기타 서비스별 인스턴스도 추가 생성 가능
// const httpInternal = createAxios({ baseURL: process.env.INTERNAL_BASE_URL });

module.exports = {
  createAxios,
  httpExternal,
  normalizeAxiosError,
};
