'use strict';

/**
 * Claves CRM IA — servidor HTTP.
 *
 * Sem framework web de proposito: menos superficie de dependencia num
 * repositorio publico. O roteador abaixo e pequeno e explicito, e toda rota
 * que muda estado passa por autenticacao + validacao de origem + CSRF.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('./src/config');
const db = require('./src/store/db');
const sessao = require('./src/security/sessao');
const limites = require('./src/security/limites');
const auth = require('./src/rotas/auth');
const api = require('./src/rotas/api');
const { cabecalhosSeguranca, erro, ipCliente } = require('./src/lib/http');

// ---------------------------------------------------------------- roteador

const rotas = [];

function rota(metodo, padrao, manipulador, opcoes = {}) {
  // Converte "/api/leads/:id" em regex com captura posicional.
  const nomes = [];
  const regex = new RegExp(
    `^${padrao
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/:([a-zA-Z]+)/g, (_, nome) => {
        nomes.push(nome);
        return '/([^/]+)';
      })}$`
  );
  rotas.push({ metodo, regex, nomes, manipulador, ...opcoes });
}

const PUBLICA = { publica: true };

rota('POST', '/api/auth/login', auth.login, PUBLICA);
rota('POST', '/api/auth/logout', auth.logout);
rota('GET', '/api/auth/sessao', auth.sessaoAtual);
rota('POST', '/api/auth/senha', auth.trocarSenha);

rota('GET', '/api/meta', api.metadados);

rota('GET', '/api/leads', api.listarLeads);
rota('GET', '/api/leads/exportar', api.exportarCsv);
rota('GET', '/api/leads/:id', api.obterLead);
rota('PATCH', '/api/leads/:id', api.atualizarLead);
rota('DELETE', '/api/leads/:id', api.removerLead);

rota('GET', '/api/config', api.listarConfiguracoes);
rota('POST', '/api/config/llm', api.criarCredencial);
rota('DELETE', '/api/config/llm/:id', api.excluirCredencial);
rota('POST', '/api/config/llm/:id/ativar', api.ativarCredencial);
rota('POST', '/api/config/llm/:id/testar', api.testarCredencial);
rota('POST', '/api/config/busca', api.salvarBuscaWeb);
rota('DELETE', '/api/config/busca', api.removerBuscaWeb);

rota('POST', '/api/pesquisar', api.pesquisar, { streaming: true });
rota('GET', '/api/execucoes', api.listarExecucoes);

// ------------------------------------------------------ arquivos estaticos

const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function servirEstatico(req, res, caminhoUrl) {
  const relativo = caminhoUrl === '/' ? 'index.html' : caminhoUrl.replace(/^\/+/, '');

  // Resolve e confirma que o alvo permanece dentro de public/ — barra
  // qualquer tentativa de path traversal (../, encoding, etc).
  const alvo = path.resolve(config.diretorioPublico, relativo);
  const raiz = path.resolve(config.diretorioPublico);
  if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) {
    return erro(res, 403, 'Acesso negado.');
  }

  let info;
  try {
    info = await fsp.stat(alvo);
    if (info.isDirectory()) throw new Error('diretorio');
  } catch {
    // SPA: rota sem extensao cai no index.
    if (!relativo.includes('.')) return servirEstatico(req, res, '/');
    return erro(res, 404, 'Nao encontrado.');
  }

  const extensao = path.extname(alvo).toLowerCase();
  const conteudo = await fsp.readFile(alvo);
  res.writeHead(200, {
    'Content-Type': TIPOS_MIME[extensao] || 'application/octet-stream',
    'Content-Length': conteudo.length,
    'Cache-Control': extensao === '.html' ? 'no-store' : 'public, max-age=300',
  });
  res.end(conteudo);
}

// ------------------------------------------------------------- middlewares

const METODOS_MUTANTES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function tratar(req, res) {
  cabecalhosSeguranca(res);

  let url;
  try {
    url = new URL(req.url, config.origemCanonica);
  } catch {
    return erro(res, 400, 'Requisicao invalida.');
  }
  const caminho = url.pathname;

  if (!caminho.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return erro(res, 405, 'Metodo nao permitido.');
    return servirEstatico(req, res, caminho);
  }

  // Rate limit geral por IP em toda a API.
  const ip = ipCliente(req);
  const controle = limites.consumir(`api:${ip}`, limites.REGRAS.api.limite, limites.REGRAS.api.janelaMs);
  if (!controle.permitido) return erro(res, 429, 'Requisicoes demais. Aguarde um momento.');

  let definicao = null;
  let captura = null;
  for (const candidata of rotas) {
    if (candidata.metodo !== req.method) continue;
    const encontrado = caminho.match(candidata.regex);
    if (encontrado) {
      definicao = candidata;
      captura = encontrado;
      break;
    }
  }

  if (!definicao) {
    const outroMetodo = rotas.some((r) => caminho.match(r.regex));
    return erro(
      res,
      outroMetodo ? 405 : 404,
      outroMetodo ? 'Metodo nao permitido.' : 'Rota nao encontrada.'
    );
  }

  const parametros = {};
  definicao.nomes.forEach((nome, indice) => {
    parametros[nome] = decodeURIComponent(captura[indice + 1]);
  });

  const contexto = { url, parametros, ip };

  if (!definicao.publica) {
    const cookies = sessao.lerCookies(req);
    const idSessao = cookies.get(config.cookieNome);
    const dadosSessao = sessao.obter(idSessao);
    if (!dadosSessao) return erro(res, 401, 'Sessao expirada. Faca login novamente.');

    const usuario = db.estado().usuarios.find((u) => u.id === dadosSessao.usuarioId);
    if (!usuario) {
      sessao.destruir(idSessao);
      return erro(res, 401, 'Usuario nao encontrado.');
    }

    contexto.idSessao = idSessao;
    contexto.sessao = dadosSessao;
    contexto.usuario = usuario;
  }

  // Defesa em profundidade contra CSRF: SameSite=Strict no cookie, checagem
  // de Origin e token double-submit. Precisa passar nos tres.
  if (METODOS_MUTANTES.has(req.method)) {
    if (!sessao.origemValida(req)) {
      return erro(res, 403, 'Origem da requisicao nao autorizada.');
    }
    if (!definicao.publica && !sessao.csrfValido(req, contexto.sessao)) {
      return erro(res, 403, 'Token CSRF invalido ou ausente.');
    }
  }

  await definicao.manipulador(req, res, contexto);
}

const servidor = http.createServer((req, res) => {
  tratar(req, res).catch((falha) => {
    const status = falha.status || 500;
    if (status >= 500) console.error('[claves] erro nao tratado:', falha);
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    // Nunca vazamos stack trace nem detalhe interno para o cliente.
    erro(res, status, status >= 500 ? 'Erro interno do servidor.' : falha.message);
  });
});

servidor.headersTimeout = 30 * 1000;
servidor.requestTimeout = 0; // o SSE da pesquisa e uma conexao longa
servidor.keepAliveTimeout = 65 * 1000;

// -------------------------------------------------------------------- boot

async function iniciar() {
  if (!fs.existsSync(config.diretorioPublico)) {
    throw new Error(`Diretorio public/ nao encontrado em ${config.diretorioPublico}`);
  }

  db.estado(); // forca carga/criacao do banco
  await auth.bootstrapAdmin();

  if (db.estado().usuarios.length === 0) {
    console.warn(
      '\n[claves] AVISO: nenhum usuario cadastrado.\n' +
        '         Crie o primeiro acesso com:  npm run criar-usuario\n' +
        '         ou preencha ADMIN_EMAIL e ADMIN_PASSWORD no .env.\n'
    );
  }

  if (config.chaveMestraEfemera) {
    console.warn(
      '[claves] AVISO: APP_MASTER_KEY nao definida — usando chave efemera.\n' +
        '         As chaves de API salvas NAO sobrevivem a um restart.\n' +
        '         Gere uma chave fixa com: npm run gerar-chave\n'
    );
  }

  servidor.listen(config.porta, config.host, () => {
    console.log(`[claves] CRM IA no ar em http://${config.host}:${config.porta}`);
    console.log(`[claves] ambiente: ${config.NODE_ENV} | origem esperada: ${config.origemCanonica}`);
  });
}

function encerrar(sinal) {
  console.log(`\n[claves] recebido ${sinal}, encerrando...`);
  // Nao gravamos o cache no desligamento de proposito: toda mutacao ja
  // persistiu de forma atomica no momento em que aconteceu. Um "save final"
  // aqui sobrescreveria o arquivo com um estado possivelmente defasado.
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

iniciar().catch((falha) => {
  console.error('[claves] falha ao iniciar:', falha.message);
  process.exit(1);
});
