FROM rust:1.94.0-slim AS builder
# Install python3 and maturin for the build process
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages maturin

WORKDIR /io
COPY ./scanner /io/scanner
WORKDIR /io/scanner

# Build the release wheel
RUN maturin build --release --out dist

FROM python:3.13-slim

# Install runtime dependencies for tree-sitter if necessary
RUN apt-get update && apt-get install -y libstdc++6 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/model_md/apps/mcp-servers/mcp-ast-service

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=builder /io/scanner/dist/*.whl .
RUN pip install *.whl && rm *.whl

COPY . .

ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "main.py"]
