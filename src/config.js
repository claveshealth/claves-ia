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

  let buffer = null;
  if (/^[0-9a-fA-F]{64}$/.test(bruto)) {
    buffer = Buffer.from(bruto, 'hex');
  } else {
    const decodificado = Buffer.from(bruto, 'base64');
    // Buffer.from com base64 nunca lanca erro; validamos pelo tamanho.
    if (decodificado.length === 32) buffer = decodificado;
  }

  if (!buffer || buffer.length !== 32) {
    throw new Error(
      'APP_MASTER_KEY invalida: precisa ser 32 bytes em base64 ou 64 caracteres hex. Gere com: npm run gerar-chave'
    );
  }

  return { chave: buffer, efemera: false };
}

const chaveMestra = lerChaveMestra();
const appUrl = (process.env.APP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

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
