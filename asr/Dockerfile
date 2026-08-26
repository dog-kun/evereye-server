FROM python:3.10-slim

# 国内服务器直连 PyPI 常超时 → 清华镜像源（env 方式，pip 全程生效）
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

# 依赖极简：sherpa-onnx 是自带 onnxruntime 的纯 C++ 推理引擎，
# 无 torch / modelscope / librosa，装包 <100MB（对比 funasr-onnx 0.4 拖 torch 数 GB）。
RUN pip install --no-cache-dir \
    fastapi==0.111.0 \
    "uvicorn[standard]==0.30.1" \
    python-multipart==0.0.9 \
    numpy==1.26.4 \
    sherpa-onnx==1.10.28

# 构建期烘焙模型：拉 int8 Paraformer 中文模型（~230MB）进镜像，运行时零下载、离线可用。
# 用 ghproxy 镜像加速 GitHub release 下载；解压后清理压缩包与无关文件瘦身。
ADD https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2 /tmp/m.tar.bz2
RUN mkdir -p /models \
    && tar xjf /tmp/m.tar.bz2 -C /models \
    && rm -f /tmp/m.tar.bz2 \
    && rm -f /models/sherpa-onnx-paraformer-zh-2023-09-14/model.onnx \
    && rm -rf /models/sherpa-onnx-paraformer-zh-2023-09-14/test_wavs

# 构建期自检：依赖或模型缺失立刻让 build 失败，绝不把坏镜像跑到线上。
COPY app.py /srv/app.py
WORKDIR /srv
RUN python -c "import sherpa_onnx, numpy, os; \
assert os.path.exists('/models/sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx'), 'model missing'; \
print('deps-ok')"

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
