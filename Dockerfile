FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --production \
    && npm cache clean --force

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && pip3 install --no-cache-dir requests \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

COPY . .

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000

CMD ["node", "server.js"]
