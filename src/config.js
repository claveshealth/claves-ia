'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// Carregador de .env minimo (sem dependencia externa). So define variaveis
// que ainda nao existem no ambiente — o ambiente real sempre tem prioridade.
function carregarDotEnv(arquivo) {
  let bruto;
  try {
    bruto = fs.readFileSync(arquivo, 'utf8');
  } catch {
    return;
  }
  for (const linha of bruto.split(/\r?\n/)) {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) continue;
    const igual = texto.indexOf('=');
    if (igual === -1) continue;
    const chave = texto.slice(0, igual).trim();
    let valor = texto.slice(igual + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (chave && process.env[chave] === undefined) process.env[chave] = valor;
  }
}

const RAIZ = path.resolve(__dirname, '..');
carregarDotEnv(path.join(RAIZ, '.env'));

function booleano(valor, padrao = false) {
  if (valor === undefined || valor === '') return padrao;
  return /^(1|true|yes|on|sim)$/i.test(String(valor));
}

function inteiro(valor, padrao) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) ? n : padrao;
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const producao = NODE_ENV === 'production';

/**
 * A chave mestra cifra as chaves de API de LLM em repouso. Em producao ela e
 * obrigatoria: sem ela, um vazamento do arquivo de dados entregaria as chaves
 * em texto puro. Em desenvolvimento geramos uma chave efemera para nao travar
 * o primeiro boot — mas os segredos salvos nao sobrevivem a um restart.
 */
function lerChaveMestra() {
  const bruto = (process.env.APP_MASTER_KEY || '').trim();

  if (!bruto) {
    if (producao) {
      throw new Error(
        'APP_MASTER_KEY e obrigatoria em producao. Gere uma com: npm run gerar-chave'
      );
    }
    return { chave: crypto.randomBytes(32), efemera: true };
  }

  // Formato canonico, produzido por `npm run gerar-chave`: 32 bytes exatos.
  if (/^[0-9a-fA-F]{64}$/.test(bruto)) {
    return { chave: Buffer.from(bruto, 'hex'), efemera: false };
  }
  const base64 = Buffer.from(bruto, 'base64');
  // Buffer.from com base64 nunca lanca erro; validamos pelo tamanho.
  if (base64.length === 32) {
    return { chave: base64, efemera: false };
  }

  /*
   * Segredo arbitrario (ex.: o valor que o Render gera sozinho com
   * `generateValue: true`). Derivamos 32 bytes com scrypt em vez de recusar.
   *
   * Isto existe para o deploy de um clique: exigir formato exato obrigava o
   * operador a gerar a chave a mao antes de subir, e errar esse passo so
   * aparecia no primeiro boot. O sal e fixo de proposito — a derivacao precisa
   * ser reprodutivel entre reinicios, senao os dados cifrados ficariam
   * ilegiveis. A seguranca vem da entropia do segredo, nao do sal.
   *
   * Exigimos 24 caracteres para nao aceitar uma senha curta como chave mestra.
   */
  if (bruto.length >= 24) {
    const derivada = crypto.scryptSync(bruto, 'claves-crm-chave-mestra-v1', 32);
    return { chave: derivada, efemera: false };
  }

  throw new Error(
    'APP_MASTER_KEY invalida: use 64 caracteres hex, 32 bytes em base64, ou um segredo de 24+ caracteres. Gere com: npm run gerar-chave'
  );
}

const chaveMestra = lerChaveMestra();

/**
 * URL publica da aplicacao.
 *
 * Errar esta variavel e a falha mais chata do deploy: ela e comparada com o
 * cabecalho Origin para barrar CSRF, entao um valor diferente da URL real faz
 * o login responder 403 sem explicar por que. Por isso, quando a plataforma ja
 * informa a URL, usamos a dela em vez de exigir que alguem digite igual.
 *
 * Render e Railway injetam essas variaveis automaticamente.
 */
function descobrirAppUrl() {
  const explicita = (process.env.APP_URL || '').trim();
  if (explicita) return explicita;

  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.trim();
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}`;

  return 'http://127.0.0.1:3000';
}

const appUrl = descobrirAppUrl().replace(/\/+$/, '');

let origemCanonica;
try {
  origemCanonica = new URL(appUrl).origin;
} catch {
  throw new Error(`APP_URL invalida: ${appUrl}`);
}

if (producao && !appUrl.startsWith('https://')) {
  throw new Error('Em producao a APP_URL precisa usar https:// (cookies de sessao exigem Secure).');
}

const config = {
  NODE_ENV,
  producao,
  raiz: RAIZ,
  porta: inteiro(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  appUrl,
  origemCanonica,
  confiarProxy: booleano(process.env.TRUST_PROXY, false),

  diretorioDados: path.join(RAIZ, 'data'),
  arquivoDados: path.join(RAIZ, 'data', 'claves.json'),
  diretorioPublico: path.join(RAIZ, 'public'),

  chaveMestra: chaveMestra.chave,
  chaveMestraEfemera: chaveMestra.efemera,

  sessaoTtlMs: inteiro(process.env.SESSION_TTL_MIN, 480) * 60 * 1000,
  cookieSeguro: appUrl.startsWith('https://'),
  cookieNome: 'claves_sid',

  admin: {
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    senha: process.env.ADMIN_PASSWORD || '',
  },

  maxRunsConcorrentes: inteiro(process.env.MAX_RUNS_CONCORRENTES, 2),
  llmMaxTokens: inteiro(process.env.LLM_MAX_TOKENS, 16000),

  // Teto de corpo de requisicao (bytes). Protege contra exaustao de memoria.
  maxCorpoBytes: 512 * 1024,
};

module.exports = config;
