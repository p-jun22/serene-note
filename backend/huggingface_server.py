from flask import Flask, request, jsonify
from transformers import pipeline

app = Flask(__name__)

# 모델 로딩
classifier = pipeline("sentiment-analysis", model="distilbert-base-uncased-finetuned-sst-2-english")

@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json()
    text = data.get("input", "")
    result = classifier(text)
    return jsonify(result)

if __name__ == "__main__":
    app.run(port=5001)