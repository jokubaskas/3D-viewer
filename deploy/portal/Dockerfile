# Atea 3D Matuoklis – portalas (paskyros, prieigos teisės, klientų duomenys)
FROM python:3.11-slim
# ffmpeg – transliacijų persiuntimui į VPS (deploy/relay): kopijuoja srautą be perkodavimo
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "fastapi==0.115.*" "uvicorn==0.32.*"
WORKDIR /app
COPY app.py /app/
ENV PORTAL_DATA=/data
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header"]
