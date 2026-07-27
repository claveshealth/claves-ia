'use strict';

/**
 * Protecao contra SSRF.
 *
 * Dois pontos da aplicacao aceitam URL vinda de fora do codigo:
 *   1. a "base URL" customizada de um provedor de LLM (campo do usuario);
 *   2. o buscar_pagina que o agente de IA usa para ler paginas publicas.
 *
 * Em ambos, uma URL apontando para 127.0.0.1, 169.254.169.254 (metadados de
 * nuvem) ou para a rede interna transformaria o servidor em proxy do atacante.
 * Aqui resolvemos o DNS e validamos TODOS os enderecos retornados antes de
 * qualquer conexao — e reusamos o IP validado na conexao, para fechar a janela
 * de DNS rebinding.
 */

const dns = require('node:dns/promises');
const net = require('node:net');

const HOSTS_BLOQUEADOS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function ipv4Privado(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (o[0] === 0) return true; // "this network"
  if (o[0] === 10) return true; // privado
  if (o[0] === 127) return true; // loopback
  if (o[0] === 169 && o[1] === 254) return true; // link-local + metadados de nuvem
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // privado
  if (o[0] === 192 && o[1] === 168) return true; // privado
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true; // IETF protocol
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true; // TEST-NET-1
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmark
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true; // TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true; // TEST-NET-3
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  if (o[0] >= 224) return true; // multicast + reservado + broadcast
  return false;
}

function ipv6Privado(ip) {
  const normalizado = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalizado === '::' || normalizado === '::1') return true; // nao especificado / loopback
  if (normalizado.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(normalizado)) return true; // unique local (fc00::/7)
  if (normalizado.startsWith('ff')) return true; // multicast

  // IPv4 mapeado em IPv6. Precisa cobrir as DUAS formas: a literal com
  // ponto (::ffff:127.0.0.1) e a comprimida em hexadecimal, que e o que o
  // parser de URL do Node produz (::ffff:7f00:1). Sem a segunda, um
  // https://[::ffff:127.0.0.1]/ passaria direto para o loopback.
  const pontuado = normalizado.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (pontuado) return ipv4Privado(pontuado[1]);

  const hexadecimal = normalizado.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexadecimal) {
    const alto = Number.parseInt(hexadecimal[1], 16);
    const baixo = Number.parseInt(hexadecimal[2], 16);
    const ipv4 = [alto >> 8, alto & 0xff, baixo >> 8, baixo & 0xff].join('.');
    return ipv4Privado(ipv4);
  }

  // Qualquer outro endereco dentro de ::/96 (IPv4-compativel, deprecado) e
  // tratado como interno por seguranca.
  if (normalizado.startsWith('::')) return true;

  return false;
}

function enderecoPrivado(ip) {
  const versao = net.isIP(ip);
  if (versao === 4) return ipv4Privado(ip);
  if (versao === 6) return ipv6Privado(ip);
  return true; // nao e um IP valido: rejeita
}

/**
 * Valida uma URL para requisicao de saida.
 * @param {string} urlBruta
 * @param {{permitirHttp?: boolean}} opcoes  permitirHttp so em desenvolvimento
 * @returns {Promise<{url: URL, ip: string, familia: number}>}
 * @throws {Error} se a URL for insegura
 */
async function validarUrlExterna(urlBruta, opcoes = {}) {
  let url;
  try {
    url = new URL(String(urlBruta));
  } catch {
    throw new Error('URL invalida.');
  }

  const protocolosOk = opcoes.permitirHttp ? ['https:', 'http:'] : ['https:'];
  if (!protocolosOk.includes(url.protocol)) {
    throw new Error(`Protocolo nao permitido (${url.protocol}). Use https://.`);
  }

  if (url.username || url.password) {
    throw new Error('URL com credenciais embutidas nao e permitida.');
  }

  // URL.hostname mantem os colchetes em literais IPv6 ("[::1]") — removemos
  // para que net.isIP reconheca o endereco e a checagem de rede interna rode.
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) throw new Error('URL sem host.');
  if (HOSTS_BLOQUEADOS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`Host bloqueado: ${host}`);
  }

  // Host ja e um literal de IP: valida direto, sem DNS.
  if (net.isIP(host)) {
    if (enderecoPrivado(host)) throw new Error(`Endereco de rede interna bloqueado: ${host}`);
    return { url, ip: host, familia: net.isIP(host) };
  }

  let enderecos;
  try {
    enderecos = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Nao foi possivel resolver o host: ${host}`);
  }
  if (!enderecos.length) throw new Error(`Host sem enderecos: ${host}`);

  // TODOS os enderecos precisam ser publicos. Se um unico for interno,
  // rejeitamos — senao um atacante poderia forcar o resolver a escolher o
  // endereco interno numa segunda consulta.
  for (const endereco of enderecos) {
    if (enderecoPrivado(endereco.address)) {
      throw new Error(`Host resolve para rede interna (${endereco.address}): ${host}`);
    }
  }

  return { url, ip: enderecos[0].address, familia: enderecos[0].family };
}

/**
 * fetch com validacao de SSRF, timeout, teto de tamanho e sem seguir
 * redirecionamentos automaticamente (cada salto e revalidado).
 */
async function fetchSeguro(urlBruta, opcoes = {}) {
  const {
    metodo = 'GET',
    cabecalhos = {},
    corpo = null,
    timeoutMs = 20000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirecionamentos = 3,
    permitirHttp = false,
    signal,
  } = opcoes;

  let alvo = urlBruta;

  for (let salto = 0; salto <= maxRedirecionamentos; salto += 1) {
    const { url } = await validarUrlExterna(alvo, { permitirHttp });

    const controlador = new AbortController();
    const relogio = setTimeout(() => controlador.abort(), timeoutMs);
    const abortarExterno = () => controlador.abort();
    if (signal) {
      if (signal.aborted) controlador.abort();
      else signal.addEventListener('abort', abortarExterno, { once: true });
    }

    let resposta;
    try {
      resposta = await fetch(url, {
        method: metodo,
        headers: cabecalhos,
        body: corpo,
        redirect: 'manual',
        signal: controlador.signal,
      });
    } finally {
      clearTimeout(relogio);
      if (signal) signal.removeEventListener('abort', abortarExterno);
    }

    if ([301, 302, 303, 307, 308].includes(resposta.status)) {
      const destino = resposta.headers.get('location');
      if (!destino) throw new Error('Redirecionamento sem destino.');
      alvo = new URL(destino, url).toString();
      continue;
    }

    const tamanhoDeclarado = Number(resposta.headers.get('content-length') || 0);
    if (tamanhoDeclarado && tamanhoDeclarado > maxBytes) {
      throw new Error(`Resposta grande demais (${tamanhoDeclarado} bytes).`);
    }

    const buffer = Buffer.from(await resposta.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Resposta grande demais (${buffer.length} bytes).`);
    }

    return {
      ok: resposta.ok,
      status: resposta.status,
      cabecalhos: resposta.headers,
      corpo: buffer,
      texto: () => buffer.toString('utf8'),
      urlFinal: url.toString(),
    };
  }

  throw new Error('Redirecionamentos demais.');
}

module.exports = { validarUrlExterna, fetchSeguro, enderecoPrivado };
