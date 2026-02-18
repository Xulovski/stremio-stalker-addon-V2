FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --production \
    && npm cache clean --force

# Instala Python + pip + requests, forçando o pip a ignorar PEP 668
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && pip3 install --no-cache-dir --break-system-packages requests \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

COPY . .

EXPOSE 7000

ENV NODE_ENV=production \
    PORT=7000

CMD ["node", "server.js"]
