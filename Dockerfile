# Use uma imagem base Node com Debian (para poder instalar pacotes via apt)
FROM node:20-slim

# Defina o diretório de trabalho
WORKDIR /app

# Copie package.json e package-lock.json primeiro → otimiza cache de camadas
COPY package*.json ./

# Instale as dependências do Node
RUN npm install --production \
    && npm cache clean --force

# Instale Python 3 + pip + requests (e limpe cache para deixar a imagem menor)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && pip3 install --no-cache-dir requests \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copie todo o resto do código
COPY . .

# Expõe a porta que o addon Stremio geralmente usa (geralmente 7000 ou 9000+)
# Mude se o seu addon usar outra porta (veja no código ou no Render)
EXPOSE 7000

# Variáveis de ambiente úteis (opcional, mas ajuda)
ENV NODE_ENV=production \
    PORT=7000

# Comando para rodar o addon
# Ajuste conforme o seu projeto:
# - Se tiver "start" no package.json → use npm start
# - Se for node server.js ou node index.js → use isso
CMD ["npm", "start"]

# Alternativas comuns:
# CMD ["node", "server.js"]
# CMD ["node", "index.js"]
# CMD ["node", "addon.js"]
