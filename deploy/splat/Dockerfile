# Atea 3D Matuoklis – „Realistiškas vaizdas“ (Gaussian Splatting, gsplat – Apache 2.0). Tik su NVIDIA GPU.
# gsplat paruoštas paketas (be kompiliavimo): PyTorch 2.4 + CUDA 12.4 + Python 3.10 (Ubuntu 22.04)
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install torch==2.4.1 --index-url https://download.pytorch.org/whl/cu124
# packaging ir typing_extensions gsplat importuoja, bet nedeklaruoja priklausomybėmis
RUN pip3 install "numpy<2" scipy pillow fastapi "uvicorn[standard]" packaging typing_extensions \
    "https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt24cu124-cp310-cp310-linux_x86_64.whl"
# Python priklausomybės patikrinamos jau kuriant atvaizdą (gsplat CUDA modulis įkeliamas tik paleidus su GPU)
RUN python3 -c "import packaging, rich, jaxtyping, typing_extensions, scipy, PIL, fastapi, uvicorn, numpy, torch"
WORKDIR /app
COPY splat_io.py train.py app.py /app/
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
