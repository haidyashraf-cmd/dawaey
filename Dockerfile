FROM python:3.12-slim

WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONUNBUFFERED=1
ENV DAWAEY_SECURE_COOKIE=1
EXPOSE 3000

CMD ["sh", "-c", "PORT=${PORT:-3000} python3 scripts/server.py"]
