FROM python:3.10-slim

# 国内服务器直连 PyPI 常超时/被墙 → 用清华镜像源（env 方式，pip 全程生效，无需额外文件）
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

RUN pip install --no-cache-dir \
    fastapi==0.111.0 \
    "uvicorn[standard]==0.30.1" \
    python-multipart==0.0.9 \
    jieba==0.42.1 \
    funasr-onnx==0.4.0

# 构建期自检：依赖缺失（如 jieba）立刻让 build 失败，绝不把坏镜像跑到线上。
# 这一层也顺带打破陈旧的 pip 缓存层复用。
RUN python -c "import jieba, funasr_onnx; from funasr_onnx import Paraformer; print('deps-ok')"

WORKDIR /srv
COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
