# Maestro — full-pipeline hosted deployment.
#
# Unlike the Vercel path (single degraded agent inside a 300s function limit),
# a container runs the real pipeline: planner → parallel agents → verifier →
# adaptive replanning → synthesis, with durable state on a mounted volume.
#
#   docker build -t maestro .
#   docker run -p 4646:4646 -v maestro_data:/data \
#     -e OPENROUTER_API_KEY=sk-or-... -e MAESTRO_ACCESS_CODE=choose-a-code maestro

FROM node:22-slim

# Python sandbox runtime. numpy/pandas/matplotlib come from apt so the venv
# (created with --system-site-packages at startup) sees them — the agent
# prompts promise that scientific stack.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    python3-numpy python3-pandas python3-matplotlib \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    PORT=4646 \
    MAESTRO_DATA_DIR=/data

EXPOSE 4646
VOLUME ["/data"]
CMD ["node", "server.js"]
