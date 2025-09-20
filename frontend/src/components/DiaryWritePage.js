import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../api";

export default function DiaryWritePage() {
  const { dateKey } = useParams();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const handleSave = async () => {
    try {
      setSaving(true);
      await api.post("/emotions", {
        dateKey,
        text,
        createdAt: Date.now(),
      });
      alert("저장 완료");
      navigate(`/diary/view/${dateKey}`);
    } catch (e) {
      console.error("save error", e);
      alert("저장 실패");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page page-diary">
      <h2 className="page-title">{dateKey} 일기 작성</h2>
      <div className="panel">
        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="input-area"
        />
      </div>
      <div className="toolbar">
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </div>
  );
}
