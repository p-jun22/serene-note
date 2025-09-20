# backend/routes/strengthAnalysisRoute.py

from flask import Blueprint, request, jsonify
from transformers import T5Tokenizer, T5ForConditionalGeneration
from firebase_admin import firestore
from firebase_admin import auth
import torch

router = Blueprint("strength_analysis", __name__)

# 모델 로딩 (한 번만 실행)
tokenizer = T5Tokenizer.from_pretrained("KETI-AIR/ke-t5-base")
model = T5ForConditionalGeneration.from_pretrained("KETI-AIR/ke-t5-base")

@router.route('/analyze-strength', methods=['POST'])
def analyze_strength():
    uid = request.json.get('uid')
    if not uid:
        return jsonify({"error": "uid is required"}), 400

    db = firestore.client()
    feedback_ref = db.collection("users").document(uid).collection("feedback")
    entries = feedback_ref.stream()

    emotion_counter = {}
    for doc in entries:
        data = doc.to_dict()
        감정들 = data.get('감정', [])
        for e in 감정들:
            emotion_counter[e] = emotion_counter.get(e, 0) + 1

    if not emotion_counter:
        return jsonify({"error": "No emotion data found"}), 404

    # 감정 요약 프롬프트 생성
    summary_input = "감정 빈도: " + ", ".join([f"{k}:{v}" for k, v in emotion_counter.items()])
    prompt = f"다음 감정 데이터를 바탕으로 사용자의 성격적 강점과 약점을 서술하세요:\n{summary_input}"

    inputs = tokenizer(prompt, return_tensors="pt", truncation=True)
    with torch.no_grad():
        output = model.generate(**inputs, max_length=128, do_sample=True, top_k=50, top_p=0.95)
    decoded = tokenizer.decode(output[0], skip_special_tokens=True)

    return jsonify({
        "summary": decoded,
        "raw": emotion_counter
    })
