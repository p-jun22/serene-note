import React, { useState } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
} from 'firebase/auth';
import { auth } from '../firebase';

// Firebase 에러 코드 → 한글 메시지 매핑
function prettyError(code) {
  switch (code) {
    case 'auth/invalid-credential':
      return '이메일 또는 비밀번호가 올바르지 않아요. 처음이라면 회원가입을 진행해 주세요.';
    case 'auth/invalid-email':
      return '이메일 형식이 올바르지 않습니다.';
    case 'auth/email-already-in-use':
      return '이미 사용 중인 이메일입니다.';
    case 'auth/weak-password':
      return '비밀번호가 너무 짧습니다. 아래 규칙을 확인해 주세요.';
    default:
      return '';
  }
}

// 규칙 체크 유틸
const hasLetter = (s) => /[A-Za-z]/.test(s);
const hasNumber = (s) => /\d/.test(s);

export default function Auth() {
  const [tab, setTab] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showPw2, setShowPw2] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isSignup = tab === 'signup';

  // ▶ 명시적 회원가입 규칙
  // 1) 길이 8자 이상
  // 2) 영문 + 숫자 포함
  // 3) 비밀번호 확인과 일치
  const minLenOk = pw.length >= 8;
  const comboOk  = hasLetter(pw) && hasNumber(pw);
  const matchOk  = !isSignup || (pw2.length > 0 && pw === pw2);

  const canSubmit = isSignup
    ? !!email && !!pw && !!pw2 && minLenOk && comboOk && matchOk
    : !!email && !!pw;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit || loading) return;
    setError('');
    setLoading(true);
    try {
      if (isSignup) {
        await createUserWithEmailAndPassword(auth, email, pw);
        // 성공 시 자동 로그인 → App에서 캘린더 진입
      } else {
        await signInWithEmailAndPassword(auth, email, pw);
      }
    } catch (err) {
      setError(prettyError(err?.code) || err?.message || '인증 중 문제가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const resetPw = async () => {
    if (!email) { setError('재설정을 위해 이메일을 입력해 주세요.'); return; }
    try {
      await sendPasswordResetEmail(auth, email);
      setError('재설정 메일을 보냈어요. 메일함을 확인해 주세요.');
    } catch (err) {
      setError(prettyError(err?.code) || '재설정 메일 전송 중 문제가 발생했습니다.');
    }
  };

  // 규칙 라인 UI (체크/엑스와 색상으로 명확히)
  const Rule = ({ ok, children }) => (
    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'2px 0',
                  color: ok ? 'var(--success)' : '#b84c4c' }}>
      <span aria-hidden>{ok ? '✓' : '✗'}</span>
      <span>{children}</span>
    </div>
  );

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        {/* 탭 헤더 */}
        <div className="auth-tabs" role="tablist" aria-label="인증 방식">
          <button
            type="button"
            className={`auth-tab ${!isSignup ? 'active' : ''}`}
            onClick={() => { setTab('login'); setError(''); }}
            aria-current={!isSignup ? 'page' : undefined}
          >
            로그인
          </button>
          <button
            type="button"
            className={`auth-tab ${isSignup ? 'active' : ''}`}
            onClick={() => { setTab('signup'); setError(''); }}
            aria-current={isSignup ? 'page' : undefined}
          >
            회원가입
          </button>
        </div>

        {/* 폼 */}
        <form className="auth-form" onSubmit={submit}>
          <label>
            이메일
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>

          <label>
            비밀번호
            <div className="pw-field">
              <input
                type={showPw ? 'text' : 'password'}
                placeholder="비밀번호"
                value={pw}
                onChange={e => setPw(e.target.value)}
                required
                autoComplete={isSignup ? 'new-password' : 'current-password'}
              />
              <button
                type="button"
                className="linklike"
                onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? '비밀번호 숨기기' : '비밀번호 보기'}
              >
                {showPw ? '숨기기' : '보기'}
              </button>
            </div>
          </label>

          {isSignup && (
            <>
              <label>
                비밀번호 확인
                <div className="pw-field">
                  <input
                    type={showPw2 ? 'text' : 'password'}
                    placeholder="비밀번호 확인"
                    value={pw2}
                    onChange={e => setPw2(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => setShowPw2(s => !s)}
                    aria-label={showPw2 ? '비밀번호 숨기기' : '비밀번호 보기'}
                  >
                    {showPw2 ? '숨기기' : '보기'}
                  </button>
                </div>
              </label>

              {/* 🔎 규칙 체크리스트(실시간) */}
              <div style={{ fontSize:12, marginTop:6 }} aria-live="polite">
                <Rule ok={minLenOk}>길이 8자 이상</Rule>
                <Rule ok={comboOk}>영문 + 숫자 포함</Rule>
                <Rule ok={matchOk}>비밀번호 확인과 일치</Rule>
              </div>
            </>
          )}

          {error && <div className="auth-error">{error}</div>}

          <div style={{ display:'flex', justifyContent:'space-between', marginTop:6 }}>
            <button type="button" className="linklike" onClick={resetPw}>
              비밀번호 재설정
            </button>
            <span />
          </div>

          <button
            type="submit"
            className="btn primary auth-submit"
            disabled={!canSubmit || loading}
            aria-disabled={!canSubmit || loading}
            title={
              isSignup && !canSubmit
                ? '회원가입 규칙을 모두 충족하면 활성화됩니다.'
                : undefined
            }
          >
            {loading ? '처리 중…' : isSignup ? '회원가입' : '로그인'}
          </button>
        </form>

        <div className="auth-help">
          {isSignup ? '이미 계정이 있나요?' : '계정이 없나요?'}{' '}
          <button
            type="button"
            className="linklike"
            onClick={() => {
              setTab(isSignup ? 'login' : 'signup');
              setError(''); setPw(''); setPw2('');
            }}
          >
            {isSignup ? '로그인으로' : '회원가입으로'}
          </button>
        </div>
      </div>
    </div>
  );
}
