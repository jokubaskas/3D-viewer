# Atea 3D Matuoklis – portalas (paskyros, prieigos teisės, klientų duomenys)
FROM python:3.11-slim
RUN pip install --no-cache-dir "fastapi==0.115.*" "uvicorn==0.32.*"
WORKDIR /app
COPY app.py /app/
ENV PORTAL_DATA=/data
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header"]
