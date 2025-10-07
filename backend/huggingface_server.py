# backend/huggingface_server.py
# ─────────────────────────────────────────────────────────────────────────────
# [역할]
# - HF 서버(포트 5001): 제로샷 감정 분포, 핵심믿음 NLI, 요약 점수 계산
# - /scores: gptService(백엔드 5000)가 호출하는 표준 엔드포인트
#
# [이번 보강]
# 1) 기본 감정 라벨 통합(Plutchik + Ekman + 현행 유지 항목) 11종
# 2) 동의어 매핑(모델 출력 정규화) 추가 → 제로샷 안정화
# 3) 요청 본문 키 호환성: coreBelief | core_belief 모두 허용
# 4) 구조/스키마/엔드포인트 변경 없음 (/scores 그대로, 응답에 hf_scores + hf_raw)
# ─────────────────────────────────────────────────────────────────────────────

from flask import Flask, request, jsonify
from flask_cors import CORS
from transformers import pipeline
import math
import os

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=False)

# ===== 모델 로딩 =====
# - 최초 호출 시 warm-up 지연 가능
zero_shot = pipeline("zero-shot-classification", model="joeddav/xlm-roberta-large-xnli")
nli_clf   = pipeline("text-classification",        model="joeddav/xlm-roberta-large-xnli")

# ── 기본 감정 라벨(Plutchik + Ekman + 현행 유지 항목) ──
# 기쁨, 신뢰, 두려움, 놀람, 슬픔, 혐오, 분노, 기대 + 수치심, 불안, 당혹
DEFAULT_EMOTION_LABELS = [
    "기쁨", "신뢰", "두려움", "놀람", "슬픔", "혐오", "분노", "기대",
    "수치심", "불안", "당혹"
]
DEFAULT_POLARITY_LABELS = ["긍정", "부정"]

# ── 동의어/표기 변형 정규화(제로샷 안정화) ──
# - 모델/프롬프트/사용자 입력 변형을 표준 라벨로 모아준다.
EMOTION_SYNONYMS = {
    "기쁨": ["행복", "유쾌", "즐거움", "희열", "환희"],
    "신뢰": ["믿음", "안도"],
    "두려움": ["공포", "겁", "두렴", "불안감"],
    "놀람": ["경악", "깜짝"],
    "슬픔": ["우울", "상실감", "비애", "서글픔"],
    "혐오": ["역겨움", "반감"],
    "분노": ["화남", "화", "짜증", "격노", "분개"],
    "기대": ["희망", "기대감"],
    "수치심": ["부끄러움", "창피", "면목없음"],
    "불안": ["초조", "걱정", "긴장"],
    "당혹": ["난처", "난감", "당황"],
}

# 역방향 매핑 테이블(한 번 생성해두고 사용)
REVERSE_SYNONYM = {}
for canonical, syns in EMOTION_SYNONYMS.items():
    REVERSE_SYNONYM[canonical] = canonical
    for s in syns:
        REVERSE_SYNONYM[s] = canonical

def normalize_emotion(label: str) -> str:
    """모델/입력 레이블을 표준 라벨로 정규화(없으면 원본 반환)."""
    if not label:
        return label
    l = str(label).strip()
    return REVERSE_SYNONYM.get(l, l)

@app.get("/health")
def health():
    return jsonify({"ok": True})

@app.post("/zero-shot")
def zero_shot_api():
    data = request.get_json(silent=True) or {}
    text = data.get("input", "")
    labels = data.get("labels") or DEFAULT_EMOTION_LABELS
    if not text or not isinstance(labels, list) or len(labels) == 0:
        return jsonify({"error": "input and labels are required"}), 400

    # 표준 라벨/동의어도 모두 후보로 넣을 수 있지만,
    # 기본은 표준 라벨만 후보로 두고 출력 후 정규화 단계를 거치는 편이 안정적임.
    out = zero_shot(text, candidate_labels=labels, multi_label=True)
    return jsonify({"labels": out["labels"], "scores": out["scores"]})

@app.post("/nli")
def nli_api():
    data = request.get_json(silent=True) or {}
    premise = data.get("premise", "")
    hypotheses = data.get("hypotheses", [])
    if not premise or not isinstance(hypotheses, list) or len(hypotheses) == 0:
        return jsonify({"results": []})

    results = []
    for hyp in hypotheses:
        pair = premise + " </s></s> " + hyp
        pred = nli_clf(pair, top_k=3)  # label: entailment/neutral/contradiction
        label_map = {p["label"]: p["score"] for p in pred}
        results.append({
            "hypothesis": hyp,
            "entail":     float(label_map.get("entailment",    0.0)),
            "neutral":    float(label_map.get("neutral",       0.0)),
            "contradict": float(label_map.get("contradiction", 0.0)),
        })
    return jsonify({"results": results})

# ====== 점수 계산 엔드포인트 (/scores) ======
# - gptService가 호출하는 표준 라우트 (B안 유지)
# - 요청: { text, emotions?: string[], coreBelief?: string, core_belief?: string }
# - 응답: { hf_scores: {...}, hf_raw: {...} }  ← 구조 변경 없음
@app.post("/scores")
def scores_api():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()
    # 클라/백엔드 호환: coreBelief | core_belief 둘 다 수용
    core_belief = str(data.get("coreBelief", data.get("core_belief", ""))).strip()

    # LLM이 뽑아준 감정 라벨(선택) → 표준 라벨로 정규화
    emotions_in = data.get("emotions") or []
    if isinstance(emotions_in, list):
        emotions_norm = [normalize_emotion(e) for e in emotions_in if isinstance(e, str)]
    else:
        emotions_norm = []

    if not text:
        return jsonify({"error": "text required"}), 400

    # 1) 감정 분포 (제로샷)
    emo_out = zero_shot(text, candidate_labels=DEFAULT_EMOTION_LABELS, multi_label=True)
    labels = emo_out["labels"]
    scores = emo_out["scores"]
    # 모델 출력 레이블도 동의어 정규화(혹시 모를 변형에 대비) → 표준 라벨 점수 딕셔너리
    emo_dict = {}
    for lab, sc in zip(labels, scores):
        canon = normalize_emotion(lab)
        emo_dict[canon] = float(sc)

    # LLM이 선택한 감정의 평균 확률 (정규화된 표준 라벨 기준)
    chosen = [emo_dict.get(lab, 0.0) for lab in emotions_norm]
    emotions_avg = sum(chosen) / len(chosen) if len(chosen) > 0 else 0.0

    # 엔트로피 (base e): -sum p ln p
    eps = 1e-12
    entropy = -sum([p * math.log(p + eps) for p in scores])

    # 2) 핵심믿음 NLI (있을 때만)
    nli_result = {"entail": 0.0, "neutral": 0.0, "contradict": 0.0}
    if core_belief:
        pair = text + " </s></s> " + core_belief
        pred = nli_clf(pair, top_k=3)
        label_map = {p["label"]: p["score"] for p in pred}
        nli_result = {
            "entail":     float(label_map.get("entailment",    0.0)),
            "neutral":    float(label_map.get("neutral",       0.0)),
            "contradict": float(label_map.get("contradiction", 0.0)),
        }

    resp = {
        "hf_scores": {
            "emotions_avg": emotions_avg,
            "emotion_entropy": entropy,
            "core_entail": nli_result["entail"],
            "core_contradict": nli_result["contradict"],
        },
        "hf_raw": {
            "emotion": emo_dict,     # 표준 라벨 기준 확률 맵
            "nli_core": nli_result
        }
    }
    return jsonify(resp)

# ====== 간단 요약(강점/약점) – 기존 유지 ======
def _analyze_summary_logic(text: str):
    pol = zero_shot(text, candidate_labels=DEFAULT_POLARITY_LABELS, multi_label=False)
    pol_label = pol["labels"][0]
    pol_score = pol["scores"][0]

    emo = zero_shot(text, candidate_labels=DEFAULT_EMOTION_LABELS, multi_label=True)
    emo_pairs = sorted(zip(emo["labels"], emo["scores"]), key=lambda x: x[1], reverse=True)
    emo_top = [f"{normalize_emotion(lab)}({score:.2f})" for lab, score in emo_pairs[:3]]

    if pol_label == "긍정":
        summary = f"전반적으로 **긍정적** 경향이 감지됩니다(신뢰도 {pol_score:.2f})."
    else:
        summary = f"전반적으로 **부정적** 경향이 감지됩니다(신뢰도 {pol_score:.2f})."
    summary += f" 주요 감정 후보: {', '.join(emo_top)}"
    return summary

@app.route("/api/analyze-strength", methods=["POST", "OPTIONS"])
def analyze_strength_api():
    if request.method == "OPTIONS":
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

@app.route("/analyze-strength", methods=["POST", "OPTIONS"])
def analyze_strength_alias():
    return analyze_strength_api()

if __name__ == "__main__":
    # 외부 바인딩 (LAN/터널/원격 백엔드에서 접근 가능)
    port = int(os.getenv("PORT", "5001"))
    app.run(host="0.0.0.0", port=port)
