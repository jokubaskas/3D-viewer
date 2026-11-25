# Atea 3D Matuoklis – vietinė AI paslauga (RF-DETR + MobileSAM, abu Apache 2.0) ir GeoTIFF perskaičiavimas į LKS-94 (rasterio / GDAL)
FROM python:3.11-slim

# CPU versija pagal nutylėjimą; GPU: TORCH_INDEX=https://download.pytorch.org/whl/cu124
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ARG DETECTOR=medium

RUN apt-get update && apt-get install -y --no-install-recommends git curl libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir torch torchvision --index-url ${TORCH_INDEX}
RUN pip install --no-cache-dir rfdetr fastapi "uvicorn[standard]" python-multipart pillow opencv-python-headless timm rasterio \
  && pip install --no-cache-dir "git+https://github.com/ChaoningZhang/MobileSAM.git"
# Savo modelio mokymui (train.py): PyTorch Lightning ir kt.; torch versija paliekama ta pati (CPU arba GPU)
RUN pip freeze | grep -iE '^(torch|torchvision)==' > /tmp/torch.txt \
  && pip install --no-cache-dir -c /tmp/torch.txt --extra-index-url ${TORCH_INDEX} "rfdetr[train]"

# Modelių svoriai atsisiunčiami vieną kartą, kuriant vaizdą – vėliau internetas nebereikalingas
RUN mkdir -p /models \
  && (curl -fsSL -o /models/rf-detr-${DETECTOR}.pth https://repo.roboflow.com/rfdetr/${DETECTOR}_coco/checkpoint_best_regular.pth \
      || curl -fsSL -o /models/rf-detr-${DETECTOR}.pth https://storage.googleapis.com/rfdetr/${DETECTOR}_coco/checkpoint_best_regular.pth) \
  && curl -fsSL -o /models/mobile_sam.pt https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt

# Valstybinių numerių atpažinimas (fast-alpr, MIT; ONNX CPU). Modeliai (~10 MB) atsisiunčiami kuriant vaizdą.
RUN pip install --no-cache-dir "fast-alpr[onnx]==0.4.0" \
  && python -c "from fast_alpr import ALPR; ALPR()"
# Automobilio požymiai (SigLIP 2, Apache 2.0, ~0,8 GB): spalva, kėbulas, markė, modelis
RUN pip freeze | grep -iE '^(torch|torchvision)==' > /tmp/torch.txt \
  && pip install --no-cache-dir -c /tmp/torch.txt --extra-index-url ${TORCH_INDEX} open_clip_torch==4.2.2 transformers sentencepiece \
  && python -c "import open_clip; open_clip.create_model_and_transforms('ViT-B-16-SigLIP2-256', pretrained='webli'); open_clip.get_tokenizer('ViT-B-16-SigLIP2-256')"

# C kompiliatorius: mokant GPU, PyTorch (Triton) vietoje kompiliuoja pagalbinius modulius – be jo
# „RuntimeError: Failed to find C compiler“. Atskiras sluoksnis gale – kad nereikėtų iš naujo siųstis PyTorch.
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

ENV ATEA_AI_MODELS=/models ATEA_AI_DETECTOR=${DETECTOR} HF_HUB_OFFLINE=1 CC=gcc
WORKDIR /app
COPY app.py train.py vehicle.py /app/
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
