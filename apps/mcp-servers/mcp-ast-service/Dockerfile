FROM rust:1.94.0-slim AS rust-builder
WORKDIR /build
COPY ./scanner .
RUN cargo build --release

FROM python:3.12-slim

# Install runtime dependencies for tree-sitter if necessary
RUN apt-get update && apt-get install -y libstdc++6 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/model_md/apps/mcp-servers/mcp-ast-service
COPY --from=rust-builder /build/target/release/ast-scanner /usr/local/bin/ast-scanner

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "main.py"]
