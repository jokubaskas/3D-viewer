# Atea variklis (GPU): nuotraukos → 3D modelis, taškų debesis, ortofoto, DSM / DTM (COLMAP / pycolmap – BSD,
# PoissonRecon – MIT, Open3D – MIT, savas tekstūravimas, siūlės – mvs-texturing (BSD-3), ortofoto) ir realistiškas vaizdas (gsplat – Apache 2.0).
# Gylio žemėlapiai ir tankus debesis – OpenMVS (AGPL-3.0, nekeista atskira programa, licencija – /opt/openmvs/LICENSE).
# PyTorch 2.4 + CUDA 12.4 + Python 3.10 (Ubuntu 22.04). Tik su NVIDIA GPU.

# ---- OpenMVS su CUDA (DensifyPointCloud, InterfaceCOLMAP, ReconstructMesh, RefineMesh, TextureMesh) ----
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS openmvs
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
    libboost-iostreams-dev libboost-program-options-dev libboost-system-dev libboost-serialization-dev \
    libopencv-dev libcgal-dev libeigen3-dev libjpeg-dev libpng-dev libtiff-dev zlib1g-dev && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/cdcseacave/VCG.git /vcglib \
    && git clone --depth 1 --branch v2.3.0 https://github.com/cdcseacave/openMVS.git /openmvs
# 75–89: RTX 20xx–40xx; 89-virtual (PTX) – naujesnėms plokštėms sukompiliuojama paleidžiant
# libcuda.so (tvarkyklė) – tik susiejimui; paleidžiant ją pateikia NVIDIA konteinerių aplinka
RUN cmake -S /openmvs -B /build -DCMAKE_BUILD_TYPE=Release -DVCG_ROOT=/vcglib -DOpenMVS_USE_CUDA=ON \
    -DCUDA_CUDA_LIBRARY=/usr/local/cuda/lib64/stubs/libcuda.so \
    "-DCMAKE_CUDA_ARCHITECTURES=75-real;80-real;86-real;89-real;89-virtual" -DOpenMVS_USE_PYTHON=OFF \
    -DOpenMVS_USE_BREAKPAD=OFF -DOpenMVS_USE_OPENGL=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build /build -j"$(nproc)" --target DensifyPointCloud InterfaceCOLMAP ReconstructMesh RefineMesh TextureMesh \
    && mkdir -p /opt/openmvs && cp /build/bin/DensifyPointCloud /build/bin/InterfaceCOLMAP /build/bin/ReconstructMesh /build/bin/RefineMesh /build/bin/TextureMesh /openmvs/LICENSE /opt/openmvs/

# ---- mvs-texturing (OpenDroneMap, BSD-3): siūlių išlyginimas tekstūroje, kaip ODM (texrecon) ----
# Ubuntu 22.04 TBB (oneTBB 2021) – be task_scheduler_init ir tbb_stddef.h: dvi nedidelės pataisos. Atlasai – visada
# 8192 px su 2 px tarpais (kitaip ~90 tūkst. lopų su 64 px tarpais – 200+ mažų lapų, peržiūrai per sunku)
FROM ubuntu:22.04 AS mvstex
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
    libjpeg-dev libpng-dev libtiff-dev libtbb-dev && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/OpenDroneMap/mvs-texturing.git /mvstex && cd /mvstex \
    && git checkout 3baaf6d6c7cba5ee44d9a6e6da8938f2bb68fb3e \
    && sed -i 's|^  if(TBB_INCLUDE_DIRS)$|  if(TBB_INCLUDE_DIRS AND EXISTS "${TBB_INCLUDE_DIRS}/tbb/tbb_stddef.h")|' elibs/tbb/FindTBB.cmake \
    && sed -i 's|#include <tbb/task_scheduler_init.h>|#include <tbb/global_control.h>\n#include <thread>|; s|tbb::task_scheduler_init schedule(conf.num_threads > 0 ? conf.num_threads : tbb::task_scheduler_init::automatic);|tbb::global_control schedule(tbb::global_control::max_allowed_parallelism, conf.num_threads > 0 ? conf.num_threads : std::thread::hardware_concurrency());|' apps/texrecon/texrecon.cpp \
    && sed -i 's|^#define PREF_TEXTURE_SIZE (4 \* 1024)$|#define PREF_TEXTURE_SIZE (8 * 1024)|; s|^#define MIN_TEXTURE_SIZE (256)$|#define MIN_TEXTURE_SIZE (8 * 1024)|' libs/tex/generate_texture_atlases.cpp \
    && sed -i 's|size(size), padding(size >> 7), finalized(false)|size(size), padding(2), finalized(false)|' libs/tex/texture_atlas.cpp \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)" --target texrecon \
    && mkdir -p /opt/mvstex && cp build/apps/texrecon/texrecon LICENSE.txt /opt/mvstex/

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
# libegl1 / libgl1 / libgomp1 / libusb-1.0-0 – Open3D; libsm6 / libice6 – pycolmap
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip libegl1 libgl1 libgomp1 libusb-1.0-0 \
    libsm6 libice6 libopencv-imgcodecs4.5d libopencv-calib3d4.5d libboost-iostreams1.74.0 \
    libboost-program-options1.74.0 libboost-serialization1.74.0 libtbb12 libjpeg8 libpng16-16 libtiff5 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=openmvs /opt/openmvs /opt/openmvs
COPY --from=mvstex /opt/mvstex /opt/mvstex
RUN ldd /opt/mvstex/texrecon | grep "not found" && exit 1 || true
RUN ldd /opt/openmvs/DensifyPointCloud /opt/openmvs/InterfaceCOLMAP /opt/openmvs/ReconstructMesh /opt/openmvs/RefineMesh /opt/openmvs/TextureMesh | grep "not found" | grep -v libcuda.so && exit 1 || true
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
