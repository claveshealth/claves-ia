'use strict';

/**
 * Cliente SMTP minimo, sem dependencia externa.
 *
 * Por que nao nodemailer: este repositorio e publico e tem, de proposito, uma
 * unica dependencia. Enviar e-mail e um protocolo de texto simples e o que
 * precisamos aqui e pequeno — conectar, autenticar, mandar uma mensagem. Puxar
 * uma arvore de dependencias para isso aumentaria a superficie de supply chain
 * mais do que o beneficio.
 *
 * Suporta os dois modos usados na pratica:
 *   - porta 465: TLS implicito (conexao ja nasce cifrada)
 *   - porta 587: STARTTLS (comeca em texto e faz upgrade antes de autenticar)
 *
 * A senha NUNCA trafega antes do TLS estar ativo: se o servidor de 587 nao
 * anunciar STARTTLS, abortamos em vez de degradar para texto puro.
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const TIMEOUT_MS = 20000;

/** Codifica cabecalho com acento no formato MIME encoded-word (RFC 2047). */
function cabecalhoCodificado(valor) {
  const texto = String(valor || '');
  // ASCII puro passa direto — mantem o cabecalho legivel.
  if (/^[\x20-\x7E]*$/.test(texto)) return texto;
  return `=?UTF-8?B?${Buffer.from(texto, 'utf8').toString('base64')}?=`;
}

/** "Nome <email>" com o nome codificado quando tem acento. */
function enderecoFormatado(email, nome) {
  if (!nome) return email;
  return `${cabecalhoCodificado(nome)} <${email}>`;
}

/**
 * Remove CR/LF de valores que entram em cabecalho. Sem isso, um nome ou
 * assunto com "\r\n" permitiria injetar cabecalhos arbitrarios (e destinatarios
 * ocultos) na mensagem — header injection.
 */
function sanearCabecalho(valor) {
  return String(valor || '').replace(/[\r\n]+/g, ' ').trim();
}

function validarEmail(valor) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(String(valor || '').trim());
}

class ConexaoSmtp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.pendente = null;
    this.socket.setEncoding('utf8');
    this.socket.on('data', (pedaco) => this._receber(pedaco));
  }

  _receber(pedaco) {
    this.buffer += pedaco;
    // Resposta SMTP termina na linha "NNN <espaco>..."; "NNN-" e continuacao.
    const linhas = this.buffer.split(/\r?\n/);
    for (let i = 0; i < linhas.length - 1; i += 1) {
      const linha = linhas[i];
      if (/^\d{3} /.test(linha)) {
        const completa = linhas.slice(0, i + 1).join('\n');
        this.buffer = linhas.slice(i + 1).join('\n');
        const codigo = Number(linha.slice(0, 3));
        const resolver = this.pendente;
        this.pendente = null;
        if (resolver) resolver.resolve({ codigo, texto: completa });
        return;
      }
    }
  }

  esperar() {
    return new Promise((resolve, reject) => {
      const temporizador = setTimeout(() => {
        this.pendente = null;
        reject(new Error('Tempo esgotado esperando resposta do servidor SMTP.'));
      }, TIMEOUT_MS);
      this.pendente = {
        resolve: (valor) => {
          clearTimeout(temporizador);
          resolve(valor);
        },
      };
    });
  }

  async comando(linha, codigosOk) {
    this.socket.write(`${linha}\r\n`);
    const resposta = await this.esperar();
    if (codigosOk && !codigosOk.includes(resposta.codigo)) {
      // Nunca ecoamos a linha enviada: ela pode conter credencial em base64.
      throw new Error(`SMTP respondeu ${resposta.codigo}: ${resposta.texto.split('\n').pop()}`);
    }
    return resposta;
  }

  fechar() {
    try {
      this.socket.write('QUIT\r\n');
    } catch {
      /* conexao ja caiu */
    }
    this.socket.destroy();
  }
}

function conectarSimples({ host, porta }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: porta });
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => resolve(socket));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Tempo esgotado conectando em ${host}:${porta}.`));
    });
    socket.once('error', reject);
  });
}

function conectarTls({ host, porta, socketExistente }) {
  return new Promise((resolve, reject) => {
    const opcoes = { host, servername: host, minVersion: 'TLSv1.2' };
    if (socketExistente) opcoes.socket = socketExistente;
    else opcoes.port = porta;

    const socket = tls.connect(opcoes, () => {
      if (!socket.authorized && socket.authorizationError) {
        socket.destroy();
        reject(new Error(`Certificado TLS do servidor recusado: ${socket.authorizationError}`));
        return;
      }
      resolve(socket);
    });
    socket.setTimeout(TIMEOUT_MS);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Tempo esgotado no handshake TLS com ${host}.`));
    });
    socket.once('error', reject);
  });
}

/** Abre a conexao, faz EHLO/STARTTLS e autentica. Devolve a conexao pronta. */
async function abrirSessao({ host, porta, usuario, senha }) {
  const seguroDireto = Number(porta) === 465;
  let socket;

  if (seguroDireto) {
    socket = await conectarTls({ host, porta });
  } else {
    socket = await conectarSimples({ host, porta });
  }

  const conexao = new ConexaoSmtp(socket);
  const saudacao = await conexao.esperar();
  if (saudacao.codigo !== 220) {
    conexao.fechar();
    throw new Error(`Servidor SMTP recusou a conexao: ${saudacao.texto}`);
  }

  const nomeCliente = 'claves-crm';
  let capacidades = await conexao.comando(`EHLO ${nomeCliente}`, [250]);

  if (!seguroDireto) {
    if (!/STARTTLS/i.test(capacidades.texto)) {
      conexao.fechar();
      throw new Error(
        `O servidor ${host}:${porta} nao oferece STARTTLS. Enviar a senha em texto puro nao e aceitavel — use a porta 465 ou um servidor com TLS.`
      );
    }
    await conexao.comando('STARTTLS', [220]);
    const socketSeguro = await conectarTls({ host, socketExistente: conexao.socket });
    // A conexao anterior fica obsoleta: refazemos sobre o socket cifrado.
    const conexaoSegura = new ConexaoSmtp(socketSeguro);
    capacidades = await conexaoSegura.comando(`EHLO ${nomeCliente}`, [250]);
    await autenticar(conexaoSegura, capacidades.texto, usuario, senha);
    return conexaoSegura;
  }

  await autenticar(conexao, capacidades.texto, usuario, senha);
  return conexao;
}

async function autenticar(conexao, capacidades, usuario, senha) {
  if (!usuario) return; // servidor aberto na rede interna
  const b64 = (v) => Buffer.from(String(v), 'utf8').toString('base64');

  if (/AUTH[^\n]*PLAIN/i.test(capacidades)) {
    const credencial = b64(`\0${usuario}\0${senha}`);
    await conexao.comando(`AUTH PLAIN ${credencial}`, [235]);
    return;
  }
  if (/AUTH[^\n]*LOGIN/i.test(capacidades)) {
    await conexao.comando('AUTH LOGIN', [334]);
    await conexao.comando(b64(usuario), [334]);
    await conexao.comando(b64(senha), [235]);
    return;
  }
  throw new Error('O servidor SMTP nao anunciou AUTH PLAIN nem AUTH LOGIN.');
}

/** Monta a mensagem MIME. Corpo em texto puro, base64/UTF-8. */
function montarMensagem({ de, deNome, para, paraNome, responderPara, assunto, corpo }) {
  const dominio = String(de).split('@')[1] || 'claves.local';
  const idMensagem = `<${crypto.randomUUID()}@${dominio}>`;

  const cabecalhos = [
    `From: ${enderecoFormatado(de, sanearCabecalho(deNome))}`,
    `To: ${enderecoFormatado(para, sanearCabecalho(paraNome))}`,
    `Subject: ${cabecalhoCodificado(sanearCabecalho(assunto))}`,
    `Message-ID: ${idMensagem}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (responderPara) cabecalhos.push(`Reply-To: ${responderPara}`);

  // Base64 em linhas de 76 colunas, como manda o RFC 2045.
  const corpoB64 = Buffer.from(String(corpo), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  return { idMensagem, texto: `${cabecalhos.join('\r\n')}\r\n\r\n${corpoB64}` };
}

/**
 * Envia uma mensagem. Devolve { idMensagem } em caso de sucesso.
 * Lanca com mensagem legivel em qualquer falha — quem chama decide o que
 * mostrar para o usuario.
 */
async function enviar({ host, porta, usuario, senha, de, deNome, para, paraNome, responderPara, assunto, corpo }) {
  if (!validarEmail(de)) throw new Error('Remetente invalido.');
  if (!validarEmail(para)) throw new Error('Destinatario invalido.');
  if (responderPara && !validarEmail(responderPara)) throw new Error('Endereco de resposta invalido.');

  const conexao = await abrirSessao({ host, porta, usuario, senha });
  try {
    const mensagem = montarMensagem({ de, deNome, para, paraNome, responderPara, assunto, corpo });

    await conexao.comando(`MAIL FROM:<${de}>`, [250]);
    await conexao.comando(`RCPT TO:<${para}>`, [250, 251]);
    await conexao.comando('DATA', [354]);

    // Dot-stuffing: linha que comeca com "." ganha um ponto extra, senao
    // encerraria o DATA no meio da mensagem.
    const corpoSeguro = mensagem.texto.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    conexao.socket.write(`${corpoSeguro}\r\n.\r\n`);

    const resposta = await conexao.esperar();
    if (resposta.codigo !== 250) {
      throw new Error(`Servidor recusou a mensagem (${resposta.codigo}): ${resposta.texto}`);
    }
    return { idMensagem: mensagem.idMensagem };
  } finally {
    conexao.fechar();
  }
}

/** Abre e fecha a sessao so para validar host/porta/credencial. */
async function testarConexao({ host, porta, usuario, senha }) {
  const conexao = await abrirSessao({ host, porta, usuario, senha });
  conexao.fechar();
  return { ok: true };
}

module.exports = { enviar, testarConexao, validarEmail, montarMensagem, cabecalhoCodificado };
