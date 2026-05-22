# Single-image build: bundles the web app into the FastAPI image and
# serves both from port 3001. Good enough for a personal deploy on
# Fly.io / Railway / Render. For local dev use the README's two-process
# flow (Vite + uvicorn) instead — it gives you HMR.

# --- Build the web app ---
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- API runtime ---
FROM python:3.12-slim AS api
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY api/pyproject.toml /app/api/
RUN cd /app/api && pip install -e .

COPY api/ /app/api/
COPY --from=web /web/dist /app/web/dist

WORKDIR /app/api
EXPOSE 3001
CMD ["python", "main.py"]
