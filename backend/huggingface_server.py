# huggingface_server.py
from flask import Flask, request, jsonify
from flask_cors import CORS
from transformers import pipeline

# -----------------------------
# Flask 기본 설정 + CORS
# -----------------------------
app = Flask(__name__)
CORS(
    app,
    resources={r"/*": {"origins": ["http://localhost:3000", "http://127.0.0.1:3000", "*"]}},
    supports_credentials=True,
)

# -----------------------------
# 모델 로딩 (다국어 지원 XNLI 기반)
#  - zero-shot 분류와 NLI(정합성) 모두 같은 모델로 처리
#  - 한국어 입력 OK
# -----------------------------
# 참고: 'joeddav/xlm-roberta-large-xnli'는 다국어 NLI로 zero-shot에도 널리 사용
zero_shot = pipeline("zero-shot-classification", model="joeddav/xlm-roberta-large-xnli")
nli_clf   = pipeline("text-classification",        model="joeddav/xlm-roberta-large-xnli")

# 기본 라벨(예시): 감정/인지왜곡은 Node에서 넘겨줄 수도 있음
DEFAULT_EMOTION_LABELS = ["불안", "슬픔", "분노", "수치심", "기쁨", "혐오", "공포", "당혹"]
DEFAULT_POLARITY_LABELS = ["긍정", "부정"]


# -----------------------------
# Health Check
# -----------------------------
@app.get("/health")
def health():
    return jsonify({"ok": True})


# -----------------------------
# Zero-shot 분류 API
#  - 입력: { "input": "...", "labels": ["라벨1","라벨2",...] }
#  - 출력: { "labels": [...], "scores": [...] } (scores는 labels와 동일 순서)
# -----------------------------
@app.post("/zero-shot")
def zero_shot_api():
    data = request.get_json(silent=True) or {}
    text = data.get("input", "")
    labels = data.get("labels") or DEFAULT_EMOTION_LABELS
    if not text or not isinstance(labels, list) or len(labels) == 0:
        return jsonify({"error": "input and labels are required"}), 400

    out = zero_shot(text, candidate_labels=labels, multi_label=True)
    # out 구조: {sequence, labels:[...], scores:[...]}
    return jsonify({"labels": out["labels"], "scores": out["scores"]})


# -----------------------------
# NLI 정합성 API
#  - 입력: { "premise": "...", "hypotheses": ["...", "..."] }
#  - 출력: { "results": [{ "hypothesis": "...", "entail": p, "neutral": p, "contradict": p }, ...] }
# -----------------------------
@app.post("/nli")
def nli_api():
    data = request.get_json(silent=True) or {}
    premise = data.get("premise", "")
    hypotheses = data.get("hypotheses", [])
    if not premise or not isinstance(hypotheses, list) or len(hypotheses) == 0:
        return jsonify({"results": []})

    results = []
    # XLM-R NLI는 "premise </s></s> hypothesis" 형식으로 입력
    for hyp in hypotheses:
        pair = premise + " </s></s> " + hyp
        pred = nli_clf(pair, top_k=3)
        # pred: [{'label': 'entailment'|'neutral'|'contradiction', 'score': float}, ...]
        label_map = {p["label"]: p["score"] for p in pred}
        results.append({
            "hypothesis": hyp,
            "entail":     float(label_map.get("entailment",    0.0)),
            "neutral":    float(label_map.get("neutral",       0.0)),
            "contradict": float(label_map.get("contradiction", 0.0)),
        })
    return jsonify({"results": results})


# -----------------------------
# 강점 요약 API (간단 버전, 한국어 대응)
#  - 기존 호환: /api/analyze-strength (OPTIONS 포함)
#  - 동작: 입력 텍스트의 전반적 극성(긍정/부정)과 상위 감정 후보를 zero-shot으로 간단 요약
# -----------------------------
def _analyze_summary_logic(text: str):
    # 1) 전반적 극성
    pol = zero_shot(text, candidate_labels=DEFAULT_POLARITY_LABELS, multi_label=False)
    pol_label = pol["labels"][0]
    pol_score = pol["scores"][0]

    # 2) 감정 상위 후보
    emo = zero_shot(text, candidate_labels=DEFAULT_EMOTION_LABELS, multi_label=True)
    # labels/scores를 확률 높은 순으로 정렬
    emo_pairs = sorted(zip(emo["labels"], emo["scores"]), key=lambda x: x[1], reverse=True)
    emo_top = [f"{lab}({score:.2f})" for lab, score in emo_pairs[:3]]

    if pol_label == "긍정":
        summary = f"전반적으로 **긍정적** 경향이 감지됩니다(신뢰도 {pol_score:.2f})."
    else:
        summary = f"전반적으로 **부정적** 경향이 감지됩니다(신뢰도 {pol_score:.2f})."

    summary += f" 주요 감정 후보: {', '.join(emo_top)}"
    return summary

@app.route("/api/analyze-strength", methods=["POST", "OPTIONS"])
def analyze_strength_api():
    if request.method == "OPTIONS":
        # CORS preflight 대응
        return ("", 200)

    data = request.get_json(silent=True) or {}
    text = data.get("input", "")
    if not text:
        return jsonify({"summary": "입력 텍스트가 없습니다."}), 400

    try:
        summary = _analyze_summary_logic(text)
        return jsonify({"summary": summary})
    except Exception as e:
        print("analyze-strength error:", e)
        return jsonify({"error": "internal_error", "detail": str(e)}), 500

# 호환용 별칭 (원하면 둘 중 하나만 써도 됨)
@app.route("/analyze-strength", methods=["POST", "OPTIONS"])
def analyze_strength_alias():
    return analyze_strength_api()


# -----------------------------
# 앱 실행 (개발용)
# -----------------------------
if __name__ == "__main__":
    # host를 127.0.0.1로 두면 로컬 전용, 0.0.0.0으로 바꾸면 외부 접속 허용
    app.run(host="127.0.0.1", port=5001)
