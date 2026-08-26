"""
恒易记账 · 自托管语音识别服务（FunASR Paraformer 中文）

POST /asr   multipart: audio=<16k wav>   Header: Authorization: Bearer $ASR_TOKEN
        →  {"text": "识别结果"}
GET  /health → {"ok": true}

模型：paraformer-zh ONNX 量化版（首次启动自动从 ModelScope 下载约 230MB，
之后离线运行；内存峰值约 700MB —— 1核1G 机器请先加 2G swap，见 README）。
"""

import io
import os
import threading
import traceback
import wave

from fastapi import FastAPI, File, Header, HTTPException, UploadFile

ASR_TOKEN = os.environ.get("ASR_TOKEN", "evereasy-asr-v1")
MAX_SECONDS = 60

app = FastAPI()
model = None
_model_lock = threading.Lock()
# 引擎加载失败的原因（供 /asr 与 /health 诚实上报，而非 uvicorn 崩溃重启）
_load_error = None


def get_model():
    """惰性加载模型。funasr_onnx 的 import 放到函数内，
    这样任何缺失的传递依赖只会让本函数抛错、由调用方转 503，
    绝不在模块导入期崩溃 uvicorn 造成无限重启。"""
    global model, _load_error
    with _model_lock:
        if model is None:
            from funasr_onnx import Paraformer  # noqa: PLC0415
            # quantize=True 走 int8 ONNX；batch_size=1 省内存
            model = Paraformer(
                "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                quantize=True, batch_size=1, device_id=0,
            )
            _load_error = None
    return model


def _warmup():
    global _load_error
    try:
        get_model()
        print("[asr] 模型就绪", flush=True)
    except Exception as e:  # noqa: BLE001
        _load_error = f"{type(e).__name__}: {e}"
        print("[asr] 模型加载失败：", _load_error, flush=True)
        traceback.print_exc()


# 启动即后台预热：首次识别请求不再吃"下载+加载"的数十秒（进度见容器日志）
threading.Thread(target=_warmup, daemon=True, name="model-warmup").start()


def wav_pcm16_to_float32(data: bytes):
    with wave.open(io.BytesIO(data)) as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "需要 16bit 单声道 WAV"
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    import array
    samples = array.array("h", frames)
    return [x / 32768.0 for x in samples], rate


@app.post("/asr")
async def asr(audio: UploadFile = File(...), authorization: str = Header("")):
    if authorization != f"Bearer {ASR_TOKEN}":
        raise HTTPException(401, "bad token")
    data = await audio.read()
    try:
        pcm, rate = wav_pcm16_to_float32(data)
    except Exception:
        raise HTTPException(400, "仅支持 16bit 单声道 WAV")
    if len(pcm) < rate * 0.4:
        return {"text": ""}
    if len(pcm) > rate * MAX_SECONDS:
        raise HTTPException(400, f"音频超过 {MAX_SECONDS}s")
    try:
        m = get_model()
    except Exception as e:  # noqa: BLE001
        # 引擎未就绪（下载中/依赖缺失/内存不足）→ 503，客户端可降级并提示重试
        raise HTTPException(503, f"识别引擎未就绪：{type(e).__name__}")
    result = m(pcm)
    text = ""
    try:
        # funasr_onnx 返回 [[{'text': ...}]] 形状
        item = result[0][0]
        text = item["text"] if isinstance(item, dict) else str(item)
    except Exception:
        text = str(result)
    return {"text": text.strip()}


@app.get("/health")
def health():
    # ready=模型已加载可用；error=加载失败原因（便于远程诊断，不含敏感信息）
    return {"ok": True, "ready": model is not None, "error": _load_error}
