# backend/huggingface_server.py
# ===============================================================================
# [역할/구성]
# - Phase 1: /scores 에서 감정 확률·정규화 엔트로피·NLI(entail/contradict) 제공
# - Phase 2: (gptService가 적용) 보정을 위한 HF 기준 신호 제공 (키 고정)
# - Phase 3: 피드백 기반 Platt/Isotonic 학습/저장/평가
#            /calibration/train, /calibration/profile, /eval/latest
# - Phase 4: 경량 핫-리로드(/admin/reload)로 모델 아티팩트 교체
#
# [키/스키마 고정 — gptService.js 기대치]
# /scores 응답:
# {
#   "emotions_avg": number,
#   "emotion_entropy": number,               # 0~1 정규화
#   "nli_core": { "entail": number, "contradict": number },
#   "hf_raw": {
#     "emotion": { "avg": number, "entropy": number, "probs": {label: prob} },
#     "nli_core": { "entail": number, "neutral": number, "contradict": number }
#   }
# }
# ===============================================================================

from flask import Flask, request, jsonify
from flask_cors import CORS
from typing import List, Dict, Tuple
from datetime import datetime
import math, os, json, threading
import re


try:
    import torch
    HAS_TORCH = True
except Exception:
    HAS_TORCH = False

EMOTION_TEMPLATE = os.getenv("HF_EMO_TEMPLATE", "이 문장은 {} 감정을 표현한다.")
HF_BATCH = int(os.getenv("HF_BATCH", "8"))

DEVICE = -1
FP16 = False
if HAS_TORCH and torch.cuda.is_available():
    DEVICE = int(os.getenv("HF_DEVICE", "0"))
    FP16 = os.getenv("HF_FP16", "1") == "1"



# ===== 의존 패키지 로드 =====
try:
    from transformers import pipeline
except Exception as e:
    raise RuntimeError("transformers 패키지가 필요합니다. pip install transformers") from e

try:
    from google.cloud import firestore  # 선택 의존
    HAS_FIRESTORE = True
except Exception:
    HAS_FIRESTORE = False

try:
    import numpy as np
    HAS_NUMPY = True
except Exception:
    HAS_NUMPY = False

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=False)

# ===============================================================================
# 전역 상태 (모델 이름과 파이프라인 객체 분리)

# ===============================================================================
ZSL_MODEL_NAME = os.getenv("ZSL_MODEL", "joeddav/xlm-roberta-large-xnli")
NLI_MODEL_NAME = os.getenv("NLI_MODEL", "joeddav/xlm-roberta-large-xnli")

zero_shot = None  # zero-shot-classification pipeline
nli_clf   = None  # text-classification (XNLI) pipeline

_reload_lock = threading.Lock()

def load_pipelines(zsl_model_name: str, nli_model_name: str):
    kw = {}
    if DEVICE >= 0:
        kw["device"] = DEVICE
        if FP16:
            kw["torch_dtype"] = torch.float16
    z = pipeline("zero-shot-classification", model=zsl_model_name, **kw)
    n = pipeline("text-classification",      model=nli_model_name, **kw)
    return z, n

def load_models(zsl_name: str = None, nli_name: str = None):
    """전역 파이프라인(zero_shot/nli_clf)과 모델명(ZSL_MODEL_NAME/NLI_MODEL_NAME)을 안전하게 갱신."""
    global zero_shot, nli_clf, ZSL_MODEL_NAME, NLI_MODEL_NAME
    if zsl_name: ZSL_MODEL_NAME = zsl_name
    if nli_name: NLI_MODEL_NAME = nli_name
    zero_shot, nli_clf = load_pipelines(ZSL_MODEL_NAME, NLI_MODEL_NAME)

# 초기 모델 로드
load_models()

# 표준 감정 라벨(11)
DEFAULT_EMOTION_LABELS = [
    "기쁨", "신뢰", "두려움", "놀람", "슬픔", "혐오", "분노", "기대",
    "수치심", "불안", "당혹"
]
DEFAULT_POLARITY_LABELS = ["긍정", "부정"]

# --- 동의어 정규화 기본표
EMOTION_SYNONYMS = {
    "기쁨": ["행복","유쾌","즐거움","희열","환희"],
    "신뢰": ["믿음","안도"],
    "두려움": ["공포","겁","불안감"],
    "놀람": ["경악","깜짝"],
    "슬픔": ["우울","상실감","비애","서글픔"],
    "혐오": ["역겨움","반감"],
    "분노": ["화남","화","짜증","격노","분개"],
    "기대": ["희망","기대감"],
    "수치심": ["부끄러움","창피","면목없음"],
    "불안": ["초조","걱정","긴장"],
    "당혹": ["난처","난감","당황"],
}
# 확장 동의어(LLM 출력 흡수)
EMOTION_SYNONYMS.update({
    "슬픔": ["외로움","고독","무력감","허무감","공허함","좌절","절망","패배감","허탈","우울감","피곤","지침"],
    "수치심": ["죄책감","후회","자책","열등감","한심함"],
    "분노": ["억울함","원망"],
    "불안": ["스트레스","초조함","불안정","긴장감"],
    "혐오": ["불쾌","꺼림칙함"],
    "당혹": ["혼란","헷갈림","난처함"],
    "기대": ["설렘","희망"],
})
# 역매핑
REVERSE_SYNONYM = {k: k for k in EMOTION_SYNONYMS.keys()}
for k, syns in EMOTION_SYNONYMS.items():
    for s in syns:
        REVERSE_SYNONYM[s] = k

def normalize_emotion(label: str) -> str:
    if not label: return label
    return REVERSE_SYNONYM.get(str(label).strip(), str(label).strip())

EMO_AVG_MODE = os.getenv("HF_EMO_AVG_MODE", "top2")  # mean|max|top2|top3...
def _agg(vals):
    if not vals: return 0.0
    if EMO_AVG_MODE == "max":
        return float(max(vals))
    if EMO_AVG_MODE.startswith("top"):
        try: k = int(EMO_AVG_MODE[3:])
        except: k = 2
        vals = sorted(vals, reverse=True)[:max(1,k)]
    return float(sum(vals)/len(vals))


# ===============================================================================
# Firestore or LocalStore 추상화
# ===============================================================================

class Store:
    def __init__(self):
        # 환경변수로 강제 선택 가능: HF_STORE_MODE=local|firestore
        pref = (os.getenv("HF_STORE_MODE") or "").lower()
        if pref in ("local", "firestore"):
            self.mode = pref
        else:
            self.mode = "firestore" if HAS_FIRESTORE else "local"

        if self.mode == "firestore":
            try:
                self.db = firestore.Client()  # ADC 없으면 여기서 예외
            except Exception as e:
                print("[HF][Store] Firestore ADC 미설정 → local 스토어로 폴백:", e)
                self.mode = "local"

        if self.mode == "local":
            self.base = os.getenv("LOCAL_STORE", "./_hf_local_store.json")
            if not os.path.exists(self.base):
                with open(self.base, "w", encoding="utf-8") as f:
                    json.dump({}, f, ensure_ascii=False, indent=2)

    def _read_local(self):
        with open(self.base, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_local(self, data):
        with open(self.base, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def get_doc(self, path: str) -> dict:
        if self.mode == "firestore":
            ref = self.db.document(path)
            snap = ref.get()
            return snap.to_dict() or {}
        data = self._read_local()
        return data.get(path, {})

    def set_doc(self, path: str, doc: dict, merge=True):
        if self.mode == "firestore":
            ref = self.db.document(path)
            if merge: ref.set(doc, merge=True)
            else: ref.set(doc)
            return
        data = self._read_local()
        if merge and path in data and isinstance(data[path], dict):
            cur = data[path]; cur.update(doc); data[path] = cur
        else:
            data[path] = doc
        self._write_local(data)

    def list_feedback(self, uid: str = None, date_from=None, date_to=None, limit=10000):
        """피드백 표본 나열(학습용).
        - local: users/*/feedback/* 전체 혹은 특정 uid만 스캔
        - firestore: 특정 uid만 지원(전역 스캔은 배치 권장)
        """
        if self.mode == "firestore":
            if not uid:
                return []  # 전역 스캔은 운영 비용/권한 이슈로 생략
            col = self.db.collection(f"users/{uid}/feedback")
            docs = col.limit(limit).stream()
            out = []
            for d in docs:
                row = d.to_dict() or {}
                row["_id"] = d.id
                row["_uid"] = uid
                out.append(row)
            return out

        # local 모드
        data = self._read_local()
        out = []
        if uid and uid != "*":
            prefix = f"users/{uid}/feedback/"
            for k, v in data.items():
                if k.startswith(prefix):
                    one = dict(v)
                    one["_id"] = k.split(prefix, 1)[1]
                    one["_uid"] = uid
                    out.append(one)
            return out

        # uid=None 또는 uid="*": 모든 유저 스캔
        for k, v in data.items():
            if not k.startswith("users/"): continue
            if "/feedback/" not in k: continue
            parts = k.split("/")
            # k = users/{uid}/feedback/{docId}
            if len(parts) >= 4:
                _uid = parts[1]
                one = dict(v)
                one["_id"] = parts[3]
                one["_uid"] = _uid
                out.append(one)
        return out

store = Store()

def now_iso():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

# ==============================================================================
# 수치 유틸: 정규화 엔트로피, Platt, Isotonic, 메트릭
# ==============================================================================
def normalized_entropy_from_scores(scores: List[float]) -> float:
    if not scores: return 0.0
    s = sum(scores)
    if s <= 0: return 0.0
    probs = [max(1e-12, p / s) for p in scores]
    ent = -sum([p * math.log(p) for p in probs])
    max_ent = math.log(len(probs)) if len(probs) > 1 else 1.0
    return float(ent / max_ent) if max_ent > 0 else 0.0

def train_platt(ps: List[float], ys: List[int], lr=1.0, iters=200, l2=1e-4) -> Tuple[float, float]:
    """간단 로지스틱 회귀(a,b): σ(a p + b)"""
    a, b = 1.0, 0.0
    for _ in range(iters):
        grad_a = 0.0; grad_b = 0.0
        hess_a = l2;  hess_b = l2
        for p, y in zip(ps, ys):
            x = max(0.0, min(1.0, float(p)))
            z = a * x + b
            s = 1.0 / (1.0 + math.exp(-z))
            g = s - y
            grad_a += g * x
            grad_b += g
            h = s * (1 - s)
            hess_a += h * x * x
            hess_b += h
        if hess_a > 0: a -= lr * grad_a / hess_a
        if hess_b > 0: b -= lr * grad_b / hess_b
    return float(a), float(b)

def apply_platt(p: float, a: float, b: float) -> float:
    x = max(0.0, min(1.0, float(p)))
    z = a * x + b
    return 1.0 / (1.0 + math.exp(-z))

def train_isotonic(ps: List[float], ys: List[int], bins=10) -> Tuple[List[float], List[float]]:
    """간단 bin 기반 단조 맵(bins,map)."""
    if not ps: return [0,1], [0.0]
    edges = [i / bins for i in range(bins + 1)]
    counts = [0]*bins; sums = [0.0]*bins
    for p, y in zip(ps, ys):
        x = max(0.0, min(1.0, float(p)))
        idx = min(bins-1, int(x * bins))
        counts[idx] += 1
        sums[idx] += y
    acc = [(sums[i]/counts[i]) if counts[i] > 0 else None for i in range(bins)]
    last = 0.0
    for i in range(bins):
        if acc[i] is None:
            acc[i] = last
        last = acc[i]
    for i in range(1, bins):
        if acc[i] < acc[i-1]:
            acc[i] = acc[i-1]
    return edges, acc

def apply_isotonic(p: float, edges: List[float], acc: List[float]) -> float:
    x = max(0.0, min(1.0, float(p)))
    lo, hi = 0, len(edges)-1
    while lo + 1 < hi:
        mid = (lo + hi) >> 1
        if x < edges[mid]: hi = mid
        else: lo = mid
    return float(acc[lo]) if 0 <= lo < len(acc) else x

def compute_metrics(ps: List[float], ys: List[int], bins=10) -> Dict[str,float]:
    n = max(1, len(ps))
    # ECE
    edges = [i / bins for i in range(bins+1)]
    ece = 0.0
    for i in range(bins):
        lo, hi = edges[i], edges[i+1]
        bucket = [(p,y) for p,y in zip(ps,ys) if (i==bins-1 and p<=hi and p>=lo) or (p>=lo and p<hi)]
        if not bucket: continue
        conf = sum(p for p,_ in bucket)/len(bucket)
        acc  = sum(1 if (p>=0.5) == (y==1) else 0 for p,y in bucket)/len(bucket)
        ece += (len(bucket)/n) * abs(acc-conf)
    # Brier
    brier = sum((p - y)**2 for p,y in zip(ps,ys)) / n
    # EM(=accuracy), F1
    tp=fp=fn=tn=0
    for p,y in zip(ps,ys):
        pred = 1 if p>=0.5 else 0
        if pred==1 and y==1: tp+=1
        elif pred==1 and y==0: fp+=1
        elif pred==0 and y==1: fn+=1
        else: tn+=1
    acc = (tp+tn)/n
    f1 = (2*tp) / (2*tp + fp + fn) if (2*tp+fp+fn)>0 else 0.0
    if HAS_NUMPY and len(set(ys))>1:
        user_corr = float(np.corrcoef(np.array(ps), np.array(ys))[0,1])
    else:
        user_corr = 0.0
    return {"ece": float(ece), "brier": float(brier), "em": float(acc), "f1": float(f1), "user_corr": user_corr}

# ===============================================================================
# 엔드포인트: 헬스/제로샷/NLI/점수
# ===============================================================================

@app.get("/health")
def health():
    return jsonify({"ok": True, "zsl_model": ZSL_MODEL_NAME, "nli_model": NLI_MODEL_NAME})

@app.post("/zero-shot")
def zero_shot_api():
    data = request.get_json(silent=True) or {}
    text = data.get("input", "")
    labels = data.get("labels") or DEFAULT_EMOTION_LABELS
    if not text or not isinstance(labels, list) or len(labels)==0:
        return jsonify({"error": "input and labels are required"}), 400
    out = zero_shot(
        text,
        candidate_labels=labels,
        multi_label=True,
        hypothesis_template=EMOTION_TEMPLATE,
        batch_size=HF_BATCH,
    )
    return jsonify({"labels": out["labels"], "scores": out["scores"]})

@app.post("/nli")
def nli_api():
    data = request.get_json(silent=True) or {}
    premise = data.get("premise", "")
    hypotheses = data.get("hypotheses", [])
    if not premise or not isinstance(hypotheses, list) or len(hypotheses)==0:
        return jsonify({"results": []})
    results = []
    for hyp in hypotheses:
        pair = premise + " </s></s> " + hyp
        pred = nli_clf(pair, top_k=3)
        label_map = {p["label"]: p["score"] for p in pred}
        results.append({
            "hypothesis": hyp,
            "entail": float(label_map.get("entailment", 0.0)),
            "neutral": float(label_map.get("neutral", 0.0)),
            "contradict": float(label_map.get("contradiction", 0.0)),
        })
    return jsonify({"results": results})

def _split_sentences_ko(text: str):
    # 문장 분할: 줄바꿈, 문장 종결부호(., ?, !, …) 또는 "다." 패턴
    sents = re.split(r'(?:[\n\r]+|(?<=[\.!\?…])\s+|(?<=다\.)\s+)', text)
    return [s.strip() for s in sents if isinstance(s, str) and len(s.strip()) >= 3]

@app.post("/scores")
def scores_api():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()
    if not text:
        return jsonify({"error": "text required"}), 400

    core_belief = str(data.get("coreBelief", data.get("core_belief", ""))).strip()
    emotions_in = data.get("emotions") or []
    emotions_norm = [normalize_emotion(e) for e in emotions_in if isinstance(e, str)]

    # 세그먼트 플래그
    segment = False
    try:
        q = (request.args.get("segment") or "").lower()
        segment = q in ("1","true","yes")
    except Exception:
        pass
    if isinstance(data.get("segment"), bool):
        segment = segment or bool(data.get("segment"))

    if not segment:
        # --- 단일 텍스트
        emo_out = zero_shot(
            text,
            candidate_labels=DEFAULT_EMOTION_LABELS,
            multi_label=True,
            hypothesis_template=EMOTION_TEMPLATE,
            batch_size=HF_BATCH,
        )
        labels = emo_out["labels"]
        scores = [float(s) for s in emo_out["scores"]]

        emo_probs = {}
        for lab, sc in zip(labels, scores):
            canon = normalize_emotion(lab)
            emo_probs[canon] = max(sc, emo_probs.get(canon, 0.0))

        chosen = [emo_probs.get(l, 0.0) for l in emotions_norm] if emotions_norm else []
        emotions_avg = _agg(chosen)
        emotion_entropy = normalized_entropy_from_scores(scores)

        nli_result = {"entail": 0.0, "neutral": 0.0, "contradict": 0.0}
        if core_belief:
            pair = text + " </s></s> " + core_belief
            pred = nli_clf(pair, top_k=3)
            label_map = {p["label"]: p["score"] for p in pred}
            nli_result = {
                "entail": float(label_map.get("entailment", 0.0)),
                "neutral": float(label_map.get("neutral", 0.0)),
                "contradict": float(label_map.get("contradiction", 0.0)),
            }

        return jsonify({
            "emotions_avg": emotions_avg,
            "emotion_entropy": emotion_entropy,
            "nli_core": {"entail": nli_result["entail"], "contradict": nli_result["contradict"]},
            "hf_raw": {
                "emotion": {"avg": emotions_avg, "entropy": emotion_entropy, "probs": emo_probs},
                "nli_core": nli_result
            }
        })

    # === 세그먼트 ON: 문장별 배치 ===
    sents = _split_sentences_ko(text) or [text]
    label_list = [normalize_emotion(l) for l in DEFAULT_EMOTION_LABELS]

    sum_probs = {l: 0.0 for l in label_list}
    entropies = []

    outs = zero_shot(
        sents,
        candidate_labels=DEFAULT_EMOTION_LABELS,
        multi_label=True,
        hypothesis_template=EMOTION_TEMPLATE,
        batch_size=HF_BATCH,
    )
    for out in outs:
        labels = out["labels"]; scores = [float(v) for v in out["scores"]]
        prob_map = {normalize_emotion(l): sc for l, sc in zip(labels, scores)}
        entropies.append(normalized_entropy_from_scores(scores))
        for l in label_list:
            sum_probs[l] += float(prob_map.get(l, 0.0))

    n_sent = float(len(sents))
    avg_probs = {l: (sum_probs[l] / n_sent) for l in label_list}

    chosen = [avg_probs.get(l, 0.0) for l in emotions_norm] if emotions_norm else []
    emotions_avg = _agg(chosen)
    emotion_entropy = float(sum(entropies)/len(entropies)) if entropies else \
        normalized_entropy_from_scores(list(avg_probs.values()))

    # 문장별 NLI(간단 루프; 필요 시 배치로 최적화 가능)
    nli_es, nli_ns, nli_cs = [], [], []
    if core_belief:
        for s in sents:
            pair = s + " </s></s> " + core_belief
            pred = nli_clf(pair, top_k=3)
            lm = {p["label"]: p["score"] for p in pred}
            nli_es.append(float(lm.get("entailment", 0.0)))
            nli_ns.append(float(lm.get("neutral", 0.0)))
            nli_cs.append(float(lm.get("contradiction", 0.0)))

    entail = float(sum(nli_es)/len(nli_es)) if nli_es else 0.0
    neutral = float(sum(nli_ns)/len(nli_ns)) if nli_ns else 0.0
    contradict = float(sum(nli_cs)/len(nli_cs)) if nli_cs else 0.0

    return jsonify({
        "emotions_avg": emotions_avg,
        "emotion_entropy": emotion_entropy,
        "nli_core": {"entail": entail, "contradict": contradict},
        "hf_raw": {
            "emotion": {"avg": emotions_avg, "entropy": emotion_entropy, "probs": avg_probs},
            "nli_core": {"entail": entail, "neutral": neutral, "contradict": contradict}
        }
    })


# ===============================================================================
# Phase 3: 캘리브레이션 학습/저장/프로필/리포트
# ===============================================================================

# 학습 데이터 스키마(권장):
# /users/{uid}/feedback/{messageId}:
# {
#   label: { emotions:[], distortions:[], coreBelief:"" },
#   rating: number|null,              # 1~5
#   model:  {
#     p_emotions, p_distortions, p_coreBelief, p_final_raw,
#     hf_entropy, hf_entail, hf_contradict
#   },
#   dateKey, is_baseline, ...
# }
#
# 보정 파라미터:
# /calibration/global { platt:{a,b}?, isotonic:{bins[], map[]}?, metrics{...} }
# /users/{uid}/calibration/current { rated_samples, min_samples, platt?, isotonic?, metrics{...} }

def _extract_training_pairs(feedback_rows: List[dict]) -> Tuple[List[float], List[int], Dict[str,float]]:
    """p, y 추출. y는 rating>=4 → 1, else 0. p는 model.p_final_raw 우선."""
    ps, ys = [], []
    entropies = []
    for r in feedback_rows:
        m = r.get("model", {}) or {}
        p = m.get("p_final_raw", None)
        if p is None:
            entropy = float(m.get("hf_entropy", 0.5))
            entail  = float(m.get("hf_entail", 0.0))
            contra  = float(m.get("hf_contradict", 0.0))
            emotions = max(0.0, min(1.0, 1.0 - entropy))
            core     = max(0.0, entail - contra)
            distort  = 0.5
            p = (emotions + core + distort) / 3.0
        else:
            p = float(p)
        rating = r.get("rating", None)
        if rating is not None:
            y = 1 if float(rating) >= 4.0 else 0
        else:
            y = 0
        ps.append(max(0.0, min(1.0, p)))
        ys.append(int(y))
        entropies.append(float(m.get("hf_entropy", 0.5)))
    summary = {"entropy_avg": float(sum(entropies)/len(entropies)) if entropies else 0.0}
    return ps, ys, summary

def _save_calibration(scope: str, uid: str, platt_ab, iso_bins_map, metrics: dict, rated_samples: int, min_samples: int=20):
    if scope == "global":
        path = "calibration/global"
        doc = {
            "ver": now_iso(),
            "sample_count": rated_samples,
            "platt": {"a": platt_ab[0], "b": platt_ab[1]} if platt_ab else None,
            "isotonic": {"bins": iso_bins_map[0], "map": iso_bins_map[1]} if iso_bins_map else None,
            "metrics": metrics,
            "updatedAt": now_iso()
        }
        store.set_doc(path, doc, merge=False)
    else:
        path = f"users/{uid}/calibration/current"
        doc = {
            "ver": now_iso(),
            "rated_samples": rated_samples,
            "min_samples": min_samples,
            "platt": {"a": platt_ab[0], "b": platt_ab[1]} if platt_ab else None,
            "isotonic": {"bins": iso_bins_map[0], "map": iso_bins_map[1]} if iso_bins_map else None,
            "metrics": metrics,
            "updatedAt": now_iso()
        }
        store.set_doc(path, doc, merge=False)

def _save_eval_run(scope: str, uid: str, metrics: dict):
    run_id = now_iso()
    doc = {
        "runId": run_id,
        "scope": scope if scope=="global" else f"user:{uid}",
        "sample_count": int(metrics.get("_n", 0)),
        "metrics": {k: float(v) for k,v in metrics.items() if k != "_n"},
        "updatedAt": now_iso()
    }
    store.set_doc(f"eval_runs/{run_id}", doc, merge=False)
    return run_id

@app.post("/calibration/train")
def calibration_train():
    data = request.get_json(silent=True) or {}
    scope = data.get("scope", "global")  # "global" | "user"
    uid = data.get("uid", None)
    algo = data.get("algo", "both")      # "platt" | "isotonic" | "both"
    min_samples = int(data.get("min_samples", 20))

    if scope not in ("global","user"):
        return jsonify({"error":"bad_scope"}), 400
    if scope == "user" and not uid:
        return jsonify({"error":"uid_required"}), 400

    if scope == "user":
        rows = store.list_feedback(uid=uid)
    else:
        # local: 모든 유저 스캔 / firestore: 전역 스캔 미지원
        if store.mode == "local":
            rows = store.list_feedback(uid="*")
        else:
            return jsonify({"error":"global_scan_not_supported_in_online_demo"}), 400

    if not rows:
        return jsonify({"error":"no_feedback_samples"}), 400

    ps, ys, extra = _extract_training_pairs(rows)
    n = len(ps)
    if n < max(5, min_samples):
        return jsonify({"error":"insufficient_samples", "found": n, "min_samples": min_samples}), 400

    platt_ab = None
    iso_bins_map = None
    if algo in ("platt","both"):
        platt_ab = train_platt(ps, ys)
    if algo in ("isotonic","both"):
        iso_bins_map = train_isotonic(ps, ys)

    metrics = compute_metrics(ps, ys)
    metrics["_n"] = n

    _save_calibration(scope, uid or "", platt_ab, iso_bins_map, metrics, rated_samples=n, min_samples=min_samples)
    run_id = _save_eval_run(scope, uid or "", metrics)

    return jsonify({
        "ok": True,
        "scope": scope,
        "uid": uid,
        "algo": algo,
        "trained": { "platt": bool(platt_ab), "isotonic": bool(iso_bins_map) },
        "metrics": {k:v for k,v in metrics.items() if k!="_n"},
        "extra": extra,
        "eval_run_id": run_id
    })

@app.get("/calibration/profile")
def calibration_profile():
    uid = request.args.get("uid", None)
    global_prof = store.get_doc("calibration/global") or {}
    personal = store.get_doc(f"users/{uid}/calibration/current") if uid else {}
    return jsonify({ "global": global_prof, "personal": personal })

@app.get("/eval/latest")
def eval_latest():
    if store.mode == "local":
        data = store._read_local()
        items = [(k,v) for k,v in data.items() if k.startswith("eval_runs/")]
        if not items: return jsonify({})
        latest = sorted(items, key=lambda kv: kv[0], reverse=True)[0][1]
        return jsonify(latest)
    else:
        return jsonify({})

# ==============================================================================
# Phase 4: 모델 핫-리로드(LoRA/Adapter 아티팩트 전환)
# ==============================================================================
@app.post("/admin/reload")
def admin_reload():
    global ZSL_MODEL_NAME, NLI_MODEL_NAME  # 참조 전에 global 선언 필수
    data = request.get_json(silent=True) or {}
    new_zsl = data.get("zsl_model") or ZSL_MODEL_NAME
    new_nli = data.get("nli_model") or NLI_MODEL_NAME
    with _reload_lock:
        load_models(new_zsl, new_nli)
    return jsonify({"ok": True, "zsl_model": ZSL_MODEL_NAME, "nli_model": NLI_MODEL_NAME})

# ==============================================================================
# 발표/요약 카드(참고)
# ==============================================================================

def _analyze_summary_logic(text: str):
    pol = zero_shot(text, candidate_labels=DEFAULT_POLARITY_LABELS, multi_label=False)
    pol_label = pol["labels"][0]; pol_score = pol["scores"][0]
    emo = zero_shot(text, candidate_labels=DEFAULT_EMOTION_LABELS, multi_label=True)
    emo_pairs = sorted(zip(emo["labels"], emo["scores"]), key=lambda x: x[1], reverse=True)
    emo_top = [f"{normalize_emotion(l)}({s:.2f})" for l,s in emo_pairs[:3]]
    if pol_label == "긍정":
        summary = f"전반적으로 **긍정적** 경향(신뢰도 {pol_score:.2f}). "
    else:
        summary = f"전반적으로 **부정적** 경향(신뢰도 {pol_score:.2f}). "
    summary += f"주요 감정 후보: {', '.join(emo_top)}"
    return summary

@app.route("/api/analyze-strength", methods=["POST", "OPTIONS"])
def analyze_strength_api():
    if request.method == "OPTIONS": return ("", 200)
    data = request.get_json(silent=True) or {}
    text = data.get("input", "")
    if not text: return jsonify({"summary": "입력 텍스트가 없습니다."}), 400
    try:
        return jsonify({ "summary": _analyze_summary_logic(text) })
    except Exception as e:
        return jsonify({"error":"internal_error","detail":str(e)}), 500

@app.route("/analyze-strength", methods=["POST", "OPTIONS"])
def analyze_strength_alias():
    return analyze_strength_api()

# ==============================================================================
# 엔트리포인트
# ==============================================================================

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    app.run(host="0.0.0.0", port=port)