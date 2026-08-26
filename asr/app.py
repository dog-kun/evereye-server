"""
恒易记账 · 自托管语音识别服务（sherpa-onnx + Paraformer 中文）

POST /asr   multipart: audio=<16k mono 16bit wav>   Header: Authorization: Bearer $ASR_TOKEN
        →  {"text": "识别结果"}
GET  /health → {"ok": true, "ready": bool, "error": str|null}

引擎：sherpa-onnx（纯 onnxruntime C++ 推理，无 torch/modelscope/librosa）。
模型：sherpa-onnx-paraformer-zh int8（构建期已烘焙进镜像，运行时零下载）。
内存峰值约 300~400MB —— 1核1G 机器加 1G swap 即可，磁盘占用 ~460MB。
"""

import io
import os
import threading
import traceback
import wave

import numpy as np
import sherpa_onnx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile

ASR_TOKEN = os.environ.get("ASR_TOKEN", "evereasy-asr-v1")
MODEL_DIR = os.environ.get(
    "ASR_MODEL_DIR", "/models/sherpa-onnx-paraformer-zh-2023-09-14"
)
MAX_SECONDS = 60

app = FastAPI()
_rec = None
_lock = threading.Lock()
# 引擎加载失败原因（供 /asr 转 503、/health 诚实上报，绝不崩 uvicorn）
_load_error = None


def get_recognizer():
    """惰性构建识别器。任何加载错误只在本函数抛出、由调用方转 503，
    绝不在模块导入期崩溃 uvicorn。"""
    global _rec, _load_error
    with _lock:
        if _rec is None:
            _rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
                paraformer=os.path.join(MODEL_DIR, "model.int8.onnx"),
                tokens=os.path.join(MODEL_DIR, "tokens.txt"),
                num_threads=1,          # 单核机器：1 线程避免上下文切换开销
                sample_rate=16000,
                feature_dim=80,
                decoding_method="greedy_search",
            )
            _load_error = None
    return _rec


def _warmup():
    global _load_error
    try:
        get_recognizer()
        print("[asr] 模型就绪", flush=True)
    except Exception as e:  # noqa: BLE001
        _load_error = f"{type(e).__name__}: {e}"
        print("[asr] 模型加载失败：", _load_error, flush=True)
        traceback.print_exc()


# 启动即后台预热：首次识别请求不再吃"加载模型"的几秒
threading.Thread(target=_warmup, daemon=True, name="model-warmup").start()


def wav_pcm16_to_float32(data: bytes):
    with wave.open(io.BytesIO(data)) as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "需要 16bit 单声道 WAV"
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, rate


@app.post("/asr")
async def asr(audio: UploadFile = File(...), authorization: str = Header("")):
    if authorization != f"Bearer {ASR_TOKEN}":
        raise HTTPException(401, "bad token")
    data = await audio.read()
    try:
        samples, rate = wav_pcm16_to_float32(data)
    except Exception:
        raise HTTPException(400, "仅支持 16bit 单声道 WAV")
    if len(samples) < rate * 0.4:
        return {"text": ""}
    if len(samples) > rate * MAX_SECONDS:
        raise HTTPException(400, f"音频超过 {MAX_SECONDS}s")
    try:
        rec = get_recognizer()
    except Exception as e:  # noqa: BLE001
        # 引擎未就绪（模型缺失/内存不足）→ 503，客户端降级并提示重试
        raise HTTPException(503, f"识别引擎未就绪：{type(e).__name__}")
    stream = rec.create_stream()
    stream.accept_waveform(rate, samples)
    rec.decode_stream(stream)
    return {"text": stream.result.text.strip()}


@app.get("/health")
def health():
    return {"ok": True, "ready": _rec is not None, "error": _load_error}
