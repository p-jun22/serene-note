import React from 'react';

export default function SharePage() {
  return (
    <div className="page" style={{ width:'100%', display:'block' }}>
      <div className="toolbar">
        <div className="title">공유</div>
      </div>

      <div style={{ maxWidth:680, margin:'16px auto', display:'grid', gap:12 }}>
        <p style={{ color:'var(--muted)' }}>
          캘린더에서 선택한 일기(또는 특정 기간)를 PDF/텍스트로 내보내거나 링크로 공유할 수 있도록 준비 중입니다.
        </p>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn" disabled>PDF로 내보내기 (준비 중)</button>
          <button className="btn" disabled>공유 링크 만들기 (준비 중)</button>
        </div>
      </div>
    </div>
  );
}
