'use strict';

/**
 * Sessoes em memoria + CSRF por double-submit token.
 *
 * Sessoes ficam so na memoria do processo de proposito: reiniciar o servidor
 * desloga todo mundo, e nenhum token de sessao toca o disco. O identificador
 * e aleatorio (32 bytes) e o cookie e httpOnly + SameSite=Strict, entao nao e
 * legivel por JavaScript nem enviado em navegacao cross-site.
 */

const config = require('../config');
const { tokenAleatorio, comparacaoSegura } = require('./crypto');

const sessoes = new Map(); // id -> { usuarioId, csrf, criadaEm, ultimoAcesso, ip, agente }

function criar(usuarioId, contexto = {}) {
  const id = tokenAleatorio(32);
  const agora = Date.now();
  sessoes.set(id, {
    usuarioId,
    csrf: tokenAleatorio(32),
    criadaEm: agora,
    ultimoAcesso: agora,
    ip: contexto.ip || null,
    agente: (contexto.agente || '').slice(0, 200),
  });
  return id;
}

function obter(id) {
  if (!id) return null;
  const sessao = sessoes.get(id);
  if (!sessao) return null;
  if (Date.now() - sessao.ultimoAcesso > config.sessaoTtlMs) {
    sessoes.delete(id);
    return null;
  }
  sessao.ultimoAcesso = Date.now(); // expiracao deslizante por inatividade
  return sessao;
}

function destruir(id) {
  if (id) sessoes.delete(id);
}

function destruirDoUsuario(usuarioId) {
  for (const [id, sessao] of sessoes) {
    if (sessao.usuarioId === usuarioId) sessoes.delete(id);
  }
}

function limpar() {
  const agora = Date.now();
  for (const [id, sessao] of sessoes) {
    if (agora - sessao.ultimoAcesso > config.sessaoTtlMs) sessoes.delete(id);
  }
}

function lerCookies(req) {
  const cabecalho = req.headers.cookie;
  const mapa = new Map();
  if (!cabecalho) return mapa;
  for (const parte of cabecalho.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    const nome = parte.slice(0, igual).trim();
    const valor = parte.slice(igual + 1).trim();
    if (nome) mapa.set(nome, decodeURIComponent(valor));
  }
  return mapa;
}

function cookieSessao(id, { expirar = false } = {}) {
  const partes = [
    `${config.cookieNome}=${expirar ? '' : encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (config.cookieSeguro) partes.push('Secure');
  partes.push(expirar ? 'Max-Age=0' : `Max-Age=${Math.floor(config.sessaoTtlMs / 1000)}`);
  return partes.join('; ');
}

/**
 * Valida a origem de requisicoes que mudam estado. O navegador nao permite
 * que uma pagina de outro site forje Origin/Referer, entao isso — somado ao
 * SameSite=Strict e ao token CSRF — cobre o vetor de CSRF em profundidade.
 */
function origemValida(req) {
  const origem = req.headers.origin;
  if (origem) return origem === config.origemCanonica;

  // Alguns clientes omitem Origin; caimos para o Referer.
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).origin === config.origemCanonica;
    } catch {
      return false;
    }
  }
  return false;
}

function csrfValido(req, sessao) {
  const enviado = req.headers['x-csrf-token'];
  if (!enviado || !sessao?.csrf) return false;
  return comparacaoSegura(enviado, sessao.csrf);
}

setInterval(limpar, 10 * 60 * 1000).unref();

module.exports = {
  criar,
  obter,
  destruir,
  destruirDoUsuario,
  lerCookies,
  cookieSessao,
  origemValida,
  csrfValido,
};
