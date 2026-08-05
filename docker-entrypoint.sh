#!/bin/sh
set -e

# O volume de dados e montado pelo provedor DEPOIS que a imagem e construida, e
# quase sempre pertence ao root. Como a aplicacao roda como `node`, sem este
# ajuste o primeiro boot morreria com EACCES ao gravar data/claves.json — e o
# sintoma no painel seria so "deploy failed", sem pista da causa.
#
# Entao: comecamos como root, corrigimos o dono do diretorio de dados e SO
# ENTAO descemos para `node`. Root nao sobrevive a esta linha.

# Caminho fixo: a aplicacao resolve data/ a partir da raiz do projeto.
DIR_DADOS="/app/data"

mkdir -p "$DIR_DADOS"

if [ "$(id -u)" = "0" ]; then
  # -R e barato aqui: sao poucos arquivos. Garante tambem os que ja existiam
  # de um deploy anterior com dono diferente.
  if ! chown -R node:node "$DIR_DADOS" 2>/dev/null; then
    echo "[claves] ERRO: nao foi possivel dar a posse de $DIR_DADOS ao usuario 'node'." >&2
    echo "[claves] O volume montado nao aceita chown. A aplicacao nao conseguiria" >&2
    echo "[claves] gravar os dados. Verifique as permissoes do disco no provedor." >&2
    exit 1
  fi
  chmod 700 "$DIR_DADOS"
  exec su-exec node "$@"
fi

# Ja rodando sem privilegio (ex.: `docker run --user`): segue direto.
exec "$@"
