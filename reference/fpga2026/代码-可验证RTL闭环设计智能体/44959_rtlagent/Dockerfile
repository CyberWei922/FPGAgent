# Build from the generated export root, never from the development repository.
# BASE_IMAGE is the image the Radeon Cloud W7900 instances run (fpgachina-rtlhls,
# rocm10-2026.1-r3), kept as published in the official reference repository.
# The organizers rebuild from this file only in the fallback mode
# (docs/API_CONTRACT.md section 8); instances have no docker.
ARG BASE_IMAGE=fpgachina-rtlhls@sha256:a7cf627e11708e8a6dcd9de689ff934f7b450b79369ebc7bb0217e8b54d81e56
# On the instance we run the official Node.js v24.15.0 linux-x64 release from
# /workspace/tools; this stage copies the same upstream release.
FROM node:24.15.0-bookworm-slim AS node_runtime
FROM ${BASE_IMAGE}
USER root
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
WORKDIR /opt/rtl-submission
COPY rtl-agent/package.json rtl-agent/package-lock.json ./rtl-agent/
RUN cd rtl-agent && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
# GGUF uses llama.cpp directly. Inventory unused image frameworks separately;
# never install/replace them just to satisfy the selected runtime.
# The image's /opt/python is Python 3.14; plain python3 on PATH may be older.
ARG PYTHON_BIN=/opt/python/bin/python3
RUN "$PYTHON_BIN" -c "import sys; assert sys.version_info[:2] == (3,14), 'Official Python 3.14 required'"
ARG INSTALL_SLANG=1
ARG INSTALL_RAG=0
RUN case "$INSTALL_RAG" in \
      0) ;; \
      1) "$PYTHON_BIN" -B competition/environment/install-rag.py --wheel-dir competition/vendor/rag/wheels --target competition/vendor/rag/site-packages ;; \
      *) exit 2 ;; \
    esac
RUN case "$INSTALL_SLANG" in \
      0) ;; \
      1) "$PYTHON_BIN" -B competition/environment/install-slang.py --wheel-dir competition/vendor/pyslang/wheels --target competition/vendor/pyslang/site-packages ;; \
      *) exit 2 ;; \
    esac
RUN chmod +x run.sh run_baseline.sh serve/start.sh competition/*.sh competition/serve/*.sh
RUN if [ -f competition/vendor/ross/vivado-mcp-server-linux-amd64-2026.9.1 ]; then chmod +x competition/vendor/ross/vivado-mcp-server-linux-amd64-2026.9.1; fi
ENV PYTHON_BIN=${PYTHON_BIN} SLANG_PYTHON=${PYTHON_BIN} TRACK=rtl EDA_TMP=/var/tmp/eda AGENT_TMP=/var/tmp SELFTEST_TMP=/var/tmp TMPDIR=/var/tmp SERVICE_STATE_DIR=/var/tmp/rtl-agent-service LLM_BASE_URL=http://127.0.0.1:8000/v1
# Weights and model identity are supplied as local mounts and environment values.
# Inference starts only via serve/start.sh; run with --init and --network none for offline acceptance.
CMD ["/bin/bash"]
