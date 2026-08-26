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
import wave

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from funasr_onnx import Paraformer

ASR_TOKEN = os.environ.get("ASR_TOKEN", "evereasy-asr-v1")
MAX_SECONDS = 60

app = FastAPI()
model = None


def get_model():
    global model
    if model is None:
        # quantize=True 走 int8 ONNX；batch_size=1 省内存
        model = Paraformer("iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                           quantize=True, batch_size=1, device_id=0)
    return model


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
    result = get_model()(pcm)
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
    return {"ok": True}
