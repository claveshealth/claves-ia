'use strict';

const config = require('../config');

function ipCliente(req) {
  if (config.confiarProxy) {
    const encaminhado = req.headers['x-forwarded-for'];
    if (encaminhado) return String(encaminhado).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'desconhecido';
}

/** Le o corpo da requisicao respeitando o teto de bytes. */
function lerCorpo(req, maxBytes = config.maxCorpoBytes) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    let finalizado = false;

    const encerrar = (erro, valor) => {
      if (finalizado) return;
      finalizado = true;
      if (erro) reject(erro);
      else resolve(valor);
    };

    req.on('data', (pedaco) => {
      total += pedaco.length;
      if (total > maxBytes) {
        const erro = new Error('Corpo da requisicao grande demais.');
        erro.status = 413;
        // Pausamos em vez de destruir o socket: assim o handler de erro
        // ainda consegue responder 413 ao cliente. Destruir aqui faria o
        // cliente ver apenas uma conexao cortada, sem explicacao.
        req.pause();
        pedacos.length = 0; // libera o que ja foi acumulado
        encerrar(erro);
        return;
      }
      pedacos.push(pedaco);
    });
    req.on('end', () => encerrar(null, Buffer.concat(pedacos)));
    req.on('error', (erro) => encerrar(erro));
  });
}

async function lerJson(req) {
  const bruto = await lerCorpo(req);
  if (!bruto.length) return {};
  const tipo = String(req.headers['content-type'] || '');
  if (!tipo.includes('application/json')) {
    const erro = new Error('Content-Type precisa ser application/json.');
    erro.status = 415;
    throw erro;
  }
  try {
    const valor = JSON.parse(bruto.toString('utf8'));
    if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
      const erro = new Error('O corpo precisa ser um objeto JSON.');
      erro.status = 400;
      throw erro;
    }
    return valor;
  } catch (erro) {
    if (erro.status) throw erro;
    const novo = new Error('JSON invalido.');
    novo.status = 400;
    throw novo;
  }
}

function cabecalhosSeguranca(res) {
  // CSP restritiva: sem inline script, sem CDN, sem framing. O front-end e
  // servido como arquivos estaticos proprios, entao nada disso e necessario.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (config.cookieSeguro) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function json(res, status, corpo, cabecalhosExtras = {}) {
  const texto = JSON.stringify(corpo ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
    ...cabecalhosExtras,
  });
  res.end(texto);
}

function erro(res, status, mensagem, extras = {}) {
  json(res, status, { erro: mensagem, ...extras });
}

function texto(valor, { max = 500, obrigatorio = false, campo = 'campo' } = {}) {
  if (valor === undefined || valor === null) {
    if (obrigatorio) {
      const e = new Error(`${campo} e obrigatorio.`);
      e.status = 400;
      throw e;
    }
    return '';
  }
  const limpo = String(valor).trim();
  if (obrigatorio && !limpo) {
    const e = new Error(`${campo} e obrigatorio.`);
    e.status = 400;
    throw e;
  }
  if (limpo.length > max) {
    const e = new Error(`${campo} excede ${max} caracteres.`);
    e.status = 400;
    throw e;
  }
  return limpo;
}

function umDe(valor, permitidos, padrao) {
  return permitidos.includes(valor) ? valor : padrao;
}

module.exports = { ipCliente, lerCorpo, lerJson, cabecalhosSeguranca, json, erro, texto, umDe };
