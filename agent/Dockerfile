# sjc-agent: build from the repo root (context .), see compose.yaml
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ipmitool && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY hw /tmp/hw
RUN pip install --no-cache-dir /tmp/hw && rm -rf /tmp/hw
COPY agent/sjc_agent.py .
ENV PYTHONUNBUFFERED=1
CMD ["python", "sjc_agent.py"]
