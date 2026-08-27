FROM python:3.10-slim

# 国内服务器直连 PyPI 常超时 → 阿里云(淘宝)镜像源（env 方式，pip 全程生效）
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PIP_TRUSTED_HOST=mirrors.aliyun.com

# 解压模型需要 unzip
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

# 依赖极简：vosk 自带 Kaldi C++ 运行时，无 torch/onnxruntime/modelscope，装包 ~30MB。
RUN pip install --no-cache-dir \
    fastapi==0.111.0 \
    "uvicorn[standard]==0.30.1" \
    python-multipart==0.0.9 \
    vosk==0.3.45

# 构建期烘焙模型：拉 vosk 中文小模型（~42MB）进镜像，运行时零下载、离线可用。
# 官方源 alphacephei.com 国内直连即可，稳定小巧。
ADD https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip /tmp/m.zip
RUN mkdir -p /models \
    && unzip -q /tmp/m.zip -d /models \
    && rm -f /tmp/m.zip

# 构建期自检：依赖或模型缺失立刻让 build 失败，绝不把坏镜像跑到线上。
COPY app.py /srv/app.py
WORKDIR /srv
RUN python -c "import vosk, os; \
assert os.path.isdir('/models/vosk-model-small-cn-0.22/am'), 'model missing'; \
print('deps-ok')"

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
