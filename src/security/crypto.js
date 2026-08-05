'use strict';

/**
 * Primitivas criptograficas da aplicacao.
 *
 * - Segredos (chaves de API de LLM) sao cifrados em repouso com AES-256-GCM,
 *   IV aleatorio por registro e AAD amarrando o texto cifrado ao seu contexto
 *   (impede que um blob cifrado seja movido de um campo para outro).
 * - Senhas usam scrypt com sal aleatorio e comparacao em tempo constante.
 */

const crypto = require('node:crypto');
const config = require('../config');

const ALGORITMO = 'aes-256-gcm';
const TAM_IV = 12; // 96 bits: tamanho recomendado para GCM
const TAM_TAG = 16;

/**
 * Cifra um segredo. `contexto` entra como AAD — precisa ser o mesmo na
 * decifragem (usamos algo como "llm:anthropic:<id>").
 * @returns {string} envelope no formato v1.<iv>.<tag>.<cifrado> em base64url
 */
function cifrar(textoPuro, contexto) {
  if (typeof textoPuro !== 'string' || textoPuro.length === 0) {
    throw new TypeError('cifrar() exige uma string nao vazia');
  }
  const iv = crypto.randomBytes(TAM_IV);
  const cipher = crypto.createCipheriv(ALGORITMO, config.chaveMestra, iv);
  cipher.setAAD(Buffer.from(String(contexto || ''), 'utf8'));
  const cifrado = Buffer.concat([cipher.update(textoPuro, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    cifrado.toString('base64url'),
  ].join('.');
}

/**
 * Decifra um envelope produzido por cifrar(). Lanca se a chave mestra mudou,
 * se o contexto nao bate ou se o dado foi adulterado.
 */
function decifrar(envelope, contexto) {
  if (typeof envelope !== 'string') throw new TypeError('envelope invalido');
  const partes = envelope.split('.');
  if (partes.length !== 4 || partes[0] !== 'v1') {
    throw new Error('Envelope cifrado em formato desconhecido');
  }
  const iv = Buffer.from(partes[1], 'base64url');
  const tag = Buffer.from(partes[2], 'base64url');
  const cifrado = Buffer.from(partes[3], 'base64url');
  if (iv.length !== TAM_IV || tag.length !== TAM_TAG) {
    throw new Error('Envelope cifrado corrompido');
  }
  const decipher = crypto.createDecipheriv(ALGORITMO, config.chaveMestra, iv);
  decipher.setAAD(Buffer.from(String(contexto || ''), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8');
}

const SCRYPT_OPCOES = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

function hashSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 12) {
    throw new Error('A senha precisa ter no minimo 12 caracteres.');
  }
  const sal = crypto.randomBytes(16);
  const derivada = crypto.scryptSync(senha.normalize('NFKC'), sal, 64, SCRYPT_OPCOES);
  return `scrypt$${SCRYPT_OPCOES.N}$${SCRYPT_OPCOES.r}$${SCRYPT_OPCOES.p}$${sal.toString('base64url')}$${derivada.toString('base64url')}`;
}

function verificarSenha(senha, armazenado) {
  try {
    const [algoritmo, n, r, p, sal, esperado] = String(armazenado).split('$');
    if (algoritmo !== 'scrypt') return false;
    const salBuf = Buffer.from(sal, 'base64url');
    const esperadoBuf = Buffer.from(esperado, 'base64url');
    const derivada = crypto.scryptSync(String(senha).normalize('NFKC'), salBuf, esperadoBuf.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 96 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derivada, esperadoBuf);
  } catch {
    return false;
  }
}

/** Compara duas strings em tempo constante (tokens, CSRF). */
function comparacaoSegura(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Ainda fazemos um compare para nao vazar o tamanho pelo tempo de retorno.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function tokenAleatorio(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function id(prefixo) {
  return `${prefixo}_${crypto.randomBytes(12).toString('hex')}`;
}

/** Mascara uma chave de API para exibicao: nunca devolvemos o valor inteiro. */
function mascarar(chave) {
  const texto = String(chave || '');
  if (texto.length <= 8) return '••••••••';
  return `${texto.slice(0, 4)}••••••••${texto.slice(-4)}`;
}

module.exports = {
  cifrar,
  decifrar,
  hashSenha,
  verificarSenha,
  comparacaoSegura,
  tokenAleatorio,
  id,
  mascarar,
};
