# Claves CRM IA — imagem de producao.
#
# Sem build step: a aplicacao e Node puro e o front-end e servido estatico.
# A imagem so precisa das dependencias de producao (hoje, uma).

FROM node:22-alpine

# dumb-init resolve o PID 1: sem ele o Node nao recebe SIGTERM e o container
# demora a encerrar, arriscando escrita pela metade no arquivo de dados.
# su-exec deixa o entrypoint largar o root depois de ajustar o volume.
RUN apk add --no-cache dumb-init su-exec

ENV NODE_ENV=production
WORKDIR /app

# Camada de dependencias separada do codigo: mudar o app nao reinstala nada.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# O banco e um arquivo em /app/data. ESTE DIRETORIO PRECISA DE VOLUME
# PERSISTENTE — sem ele, cada deploy apaga leads, usuarios e chaves cifradas.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# 0.0.0.0 porque dentro do container o padrao 127.0.0.1 nao aceitaria a
# conexao vinda do proxy do provedor.
ENV HOST=0.0.0.0 PORT=3000

# Checagem de saude: a raiz devolve o HTML da aplicacao sem exigir sessao.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/'},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# Comeca como root de proposito: o entrypoint ajusta o dono do volume montado
# e entao desce para o usuario `node`. A aplicacao NUNCA roda como root.
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
