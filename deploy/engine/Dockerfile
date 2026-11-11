# Atea variklis (GPU): nuotraukos → 3D modelis, taškų debesis, ortofoto, DSM / DTM (COLMAP / pycolmap – BSD,
# PoissonRecon – MIT, Open3D – MIT, savas tekstūravimas ir ortofoto) ir realistiškas vaizdas (gsplat – Apache 2.0).
# PyTorch 2.4 + CUDA 12.4 + Python 3.10 (Ubuntu 22.04). Tik su NVIDIA GPU.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
# libegl1 / libgl1 / libgomp1 / libusb-1.0-0 – Open3D; libsm6 / libice6 – pycolmap
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip libegl1 libgl1 libgomp1 libusb-1.0-0 \
    libsm6 libice6 && rm -rf /var/lib/apt/lists/*
RUN pip3 install torch==2.4.1 --index-url https://download.pytorch.org/whl/cu124
# packaging ir typing_extensions gsplat importuoja, bet nedeklaruoja priklausomybėmis
RUN pip3 install "numpy<2" scipy pillow fastapi "uvicorn[standard]" python-multipart packaging typing_extensions \
    open3d-cpu==0.20.0 trimesh pyproj "laspy[lazrs]" "rasterio<1.5" \
    "https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt24cu124-cp310-cp310-linux_x86_64.whl"
# COLMAP su CUDA (SIFT GPU, PatchMatch) – atskiru žingsniu, kad CUDA bibliotekų versijas derintų su PyTorch
RUN pip3 install pycolmap-cuda12==4.2.1 "numpy<2"
# Priklausomybės patikrinamos jau kuriant atvaizdą (CUDA moduliai įkeliami tik paleidus su GPU)
RUN python3 -c "import packaging, rich, jaxtyping, typing_extensions, scipy, PIL, fastapi, multipart, uvicorn, numpy, torch, \
open3d, trimesh, pyproj, laspy, lazrs, rasterio, pycolmap; assert numpy.__version__ < '2' and pycolmap.has_cuda; print('OK', pycolmap.__version__)"
WORKDIR /app
COPY *.py /app/
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
