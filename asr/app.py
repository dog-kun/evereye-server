"""
恒易记账 · 自托管语音识别服务（Vosk 中文小模型）

POST /asr   multipart: audio=<16k mono 16bit wav>   Header: Authorization: Bearer $ASR_TOKEN
        →  {"text": "识别结果"}
GET  /health → {"ok": true, "ready": bool, "error": str|null}

引擎：Vosk（Kaldi 后端，纯 C++ 推理，无 torch/modelscope/onnxruntime）。
模型：vosk-model-small-cn-0.22（~42MB，构建期烘焙进镜像，运行时零下载）。
资源：内存峰值约 200MB，磁盘占用约 250MB，1核1G 机器免 swap 也能跑。
"""

import io
import json
import os
import threading
import traceback
import wave

from fastapi import FastAPI, File, Header, HTTPException, UploadFile

ASR_TOKEN = os.environ.get("ASR_TOKEN", "evereasy-asr-v1")
MODEL_DIR = os.environ.get("ASR_MODEL_DIR", "/models/vosk-model-small-cn-0.22")
MAX_SECONDS = 60

app = FastAPI()
_model = None
_lock = threading.Lock()
# 引擎加载失败原因（供 /asr 转 503、/health 诚实上报，绝不崩 uvicorn）
_load_error = None


def get_model():
    """惰性加载模型。任何加载错误只在本函数抛出、由调用方转 503，
    绝不在模块导入期崩溃 uvicorn。"""
    global _model, _load_error
    with _lock:
        if _model is None:
            from vosk import Model, SetLogLevel  # noqa: PLC0415
            SetLogLevel(-1)  # 关掉 Kaldi 冗长日志
            _model = Model(MODEL_DIR)
            _load_error = None
    return _model


def _warmup():
    global _load_error
    try:
        get_model()
        print("[asr] 模型就绪", flush=True)
    except Exception as e:  # noqa: BLE001
        _load_error = f"{type(e).__name__}: {e}"
        print("[asr] 模型加载失败：", _load_error, flush=True)
        traceback.print_exc()


# 启动即后台预热：首次识别请求不再吃"加载模型"的两三秒
threading.Thread(target=_warmup, daemon=True, name="model-warmup").start()


@app.post("/asr")
async def asr(audio: UploadFile = File(...), authorization: str = Header("")):
    if authorization != f"Bearer {ASR_TOKEN}":
        raise HTTPException(401, "bad token")
    data = await audio.read()
    try:
        with wave.open(io.BytesIO(data)) as w:
            assert w.getnchannels() == 1 and w.getsampwidth() == 2, "需要 16bit 单声道 WAV"
            rate = w.getframerate()
            frames = w.readframes(w.getnframes())
    except Exception:
        raise HTTPException(400, "仅支持 16bit 单声道 WAV")

    nsamples = len(frames) // 2
    if nsamples < rate * 0.4:
        return {"text": ""}
    if nsamples > rate * MAX_SECONDS:
        raise HTTPException(400, f"音频超过 {MAX_SECONDS}s")

    try:
        model = get_model()
    except Exception as e:  # noqa: BLE001
        # 引擎未就绪（模型缺失/内存不足）→ 503，客户端降级并提示重试
        raise HTTPException(503, f"识别引擎未就绪：{type(e).__name__}")

    from vosk import KaldiRecognizer  # noqa: PLC0415
    rec = KaldiRecognizer(model, rate)
    rec.AcceptWaveform(frames)
    result = json.loads(rec.FinalResult())
    # Vosk 中文模型输出词间带空格（"买 了 五 块 钱"）→ 去空格还原中文连写
    text = result.get("text", "").replace(" ", "")
    return {"text": text.strip()}


@app.get("/health")
def health():
    return {"ok": True, "ready": _model is not None, "error": _load_error}
