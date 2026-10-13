# Atea 3D Matuoklis – vietinė AI paslauga (RF-DETR + MobileSAM, abu Apache 2.0)
FROM python:3.11-slim

# CPU versija pagal nutylėjimą; GPU: TORCH_INDEX=https://download.pytorch.org/whl/cu124
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ARG DETECTOR=medium

RUN apt-get update && apt-get install -y --no-install-recommends git curl libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir torch torchvision --index-url ${TORCH_INDEX}
RUN pip install --no-cache-dir rfdetr fastapi "uvicorn[standard]" python-multipart pillow opencv-python-headless timm \
  && pip install --no-cache-dir "git+https://github.com/ChaoningZhang/MobileSAM.git"

# Modelių svoriai atsisiunčiami vieną kartą, kuriant vaizdą – vėliau internetas nebereikalingas
RUN mkdir -p /models \
  && (curl -fsSL -o /models/rf-detr-${DETECTOR}.pth https://repo.roboflow.com/rfdetr/${DETECTOR}_coco/checkpoint_best_regular.pth \
      || curl -fsSL -o /models/rf-detr-${DETECTOR}.pth https://storage.googleapis.com/rfdetr/${DETECTOR}_coco/checkpoint_best_regular.pth) \
  && curl -fsSL -o /models/mobile_sam.pt https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt

ENV ATEA_AI_MODELS=/models ATEA_AI_DETECTOR=${DETECTOR} HF_HUB_OFFLINE=1
WORKDIR /app
COPY app.py /app/app.py
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
