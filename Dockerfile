# 1. 노드 설정
FROM node:20-slim

# 2. 시스템 패키지 설치 + 파이썬 경로 링크 설정
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. 작업 디렉토리
WORKDIR /app

# 4. 의존성 설치 (이제 파이썬을 찾을 수 있습니다)
COPY package*.json ./
RUN npm install

# 5. 코드 복사
COPY . .

ENV PORT=3002
EXPOSE 3002

CMD ["npm", "start"]