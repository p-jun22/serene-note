import React, { useState } from 'react';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';

const Auth = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState('');
  const auth = getAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  return (
    <div style={{ padding: '20px', maxWidth: 400, margin: 'auto' }}>
      <h2>{isRegister ? '회원가입' : '로그인'}</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ width: '100%', padding: '10px', marginBottom: '10px' }}
        />
        <input
          type="password"
          placeholder="비밀번호"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ width: '100%', padding: '10px', marginBottom: '10px' }}
        />
        <button type="submit" style={{ width: '100%', padding: '10px' }}>
          {isRegister ? '회원가입' : '로그인'}
        </button>
      </form>
      <p style={{ marginTop: 10 }}>
        {isRegister ? '이미 계정이 있으신가요?' : '계정이 없으신가요?'}{' '}
        <button onClick={() => setIsRegister(!isRegister)} style={{ background: 'none', border: 'none', color: 'blue', cursor: 'pointer' }}>
          {isRegister ? '로그인' : '회원가입'}
        </button>
      </p>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {/* <hr style={{ margin: '20px 0' }} />
      <button onClick={handleLogout} style={{ width: '100%', padding: '10px', background: '#ccc' }}>
        로그아웃
      </button> */}
    </div>
  );
};

export default Auth;
