FROM ghcr.io/astral-sh/uv:0.10.7 AS uv

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    WORKFLOW_USE_HOST=0.0.0.0 \
    WORKFLOW_USE_PORT=8090 \
    PATH=/app/.venv/bin:$PATH

WORKDIR /app

RUN groupadd --gid 10001 workflow && useradd --uid 10001 --gid workflow --create-home workflow

COPY --from=uv /uv /uvx /bin/
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev && chown -R workflow:workflow /app

USER workflow
EXPOSE 8090

CMD ["python", "-m", "workflow_use_recording"]
