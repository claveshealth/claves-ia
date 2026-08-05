'use strict';

const crypto = require('node:crypto');
const db = require('../store/db');
const sessao = require('../security/sessao');
const limites = require('../security/limites');
const email = require('./email');
const { hashSenha, verificarSenha, id: novoId, tokenAleatorio } = require('../security/crypto');
const { json, erro, lerJson, texto, ipCliente } = require('../lib/http');
const config = require('../config');

/** Cria o admin inicial a partir do .env, se ainda nao houver usuarios. */
async function bootstrapAdmin() {
  const dados = db.estado();
  if (dados.usuarios.length > 0) return null;
  if (!config.admin.email || !config.admin.senha) return null;

  if (config.admin.senha.length < 12) {
    console.error('[claves] ADMIN_PASSWORD tem menos de 12 caracteres — admin nao criado.');
    return null;
  }

  const usuario = {
    id: novoId('usr'),
    email: config.admin.email,
    nome: 'Administrador',
    papel: 'admin',
    ativo: true,
    senhaHash: hashSenha(config.admin.senha),
    criadoEm: new Date().toISOString(),
    ultimoLogin: null,
  };
  dados.usuarios.push(usuario);
  await db.salvar();
  console.log(`[claves] Usuario administrador criado: ${usuario.email}`);
  return usuario;
}

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    email: usuario.email,
    nome: usuario.nome,
    papel: usuario.papel,
    trocaSenhaObrigatoria: usuario.trocaSenhaObrigatoria === true,
  };
}

async function login(req, res) {
  const ip = ipCliente(req);
  const controleIp = limites.consumir(`login:ip:${ip}`, limites.REGRAS.login.limite, limites.REGRAS.login.janelaMs);
  if (!controleIp.permitido) {
    return erro(res, 429, 'Tentativas demais. Aguarde alguns minutos.', {
      esperarSegundos: Math.ceil(controleIp.esperarMs / 1000),
    });
  }

  const corpo = await lerJson(req);
  const email = texto(corpo.email, { campo: 'email', obrigatorio: true, max: 200 }).toLowerCase();
  const senha = String(corpo.senha || '');

  const controleConta = limites.consumir(
    `login:conta:${email}`,
    limites.REGRAS.login.limite,
    limites.REGRAS.login.janelaMs
  );
  if (!controleConta.permitido) {
    return erro(res, 429, 'Tentativas demais nesta conta. Aguarde alguns minutos.');
  }

  const dados = db.estado();
  const usuario = dados.usuarios.find((u) => u.email === email);

  // Mensagem generica e mesmo custo de verificacao nos dois ramos: nao
  // revelamos se o e-mail existe.
  const senhaOk = usuario
    ? verificarSenha(senha, usuario.senhaHash)
    : verificarSenha(senha, hashSenha('senha-invalida-placeholder'));

  if (!usuario || !senhaOk) {
    db.registrarAuditoria({ tipo: 'login_falhou', email, ip });
    await db.salvar();
    return erro(res, 401, 'E-mail ou senha invalidos.');
  }

  // Conta desativada nao entra. Mensagem propria: aqui a senha ja foi validada,
  // entao nao ha o que proteger, e o usuario precisa saber que deve falar com o
  // gestor em vez de ficar tentando a senha.
  if (usuario.ativo === false) {
    db.registrarAuditoria({ tipo: 'login_conta_desativada', usuarioId: usuario.id, ip });
    await db.salvar();
    return erro(res, 403, 'Esta conta esta desativada. Procure o gestor ou o administrador.');
  }

  limites.liberar(`login:ip:${ip}`);
  limites.liberar(`login:conta:${email}`);

  const idSessao = sessao.criar(usuario.id, { ip, agente: req.headers['user-agent'] });
  const dadosSessao = sessao.obter(idSessao);

  usuario.ultimoLogin = new Date().toISOString();
  db.registrarAuditoria({ tipo: 'login_ok', usuarioId: usuario.id, ip });
  await db.salvar();

  json(
    res,
    200,
    { usuario: usuarioPublico(usuario), csrfToken: dadosSessao.csrf },
    { 'Set-Cookie': sessao.cookieSessao(idSessao) }
  );
}

async function logout(req, res, contexto) {
  sessao.destruir(contexto.idSessao);
  json(res, 200, { ok: true }, { 'Set-Cookie': sessao.cookieSessao('', { expirar: true }) });
}

function sessaoAtual(req, res, contexto) {
  json(res, 200, {
    usuario: usuarioPublico(contexto.usuario),
    csrfToken: contexto.sessao.csrf,
  });
}

async function trocarSenha(req, res, contexto) {
  const corpo = await lerJson(req);
  const atual = String(corpo.senhaAtual || '');
  const nova = String(corpo.novaSenha || '');

  if (!verificarSenha(atual, contexto.usuario.senhaHash)) {
    return erro(res, 401, 'Senha atual incorreta.');
  }
  if (nova.length < 12) {
    return erro(res, 400, 'A nova senha precisa ter no minimo 12 caracteres.');
  }

  if (nova === atual) {
    return erro(res, 400, 'A nova senha precisa ser diferente da atual.');
  }

  contexto.usuario.senhaHash = hashSenha(nova);
  contexto.usuario.trocaSenhaObrigatoria = false;
  db.registrarAuditoria({ tipo: 'senha_alterada', usuarioId: contexto.usuario.id });
  await db.salvar();

  // Invalida todas as sessoes: trocar senha derruba sessoes antigas.
  sessao.destruirDoUsuario(contexto.usuario.id);
  json(res, 200, { ok: true, mensagem: 'Senha alterada. Faca login novamente.' },
    { 'Set-Cookie': sessao.cookieSessao('', { expirar: true }) });
}

// -------------------------------------------------- esqueci minha senha

const TTL_TOKEN_MS = 60 * 60 * 1000; // 1 hora

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Gera o token de redefinicao e grava so o hash no usuario. O token cru
 * aparece uma unica vez (no e-mail); se o arquivo de dados vazar, os hashes
 * nao servem para redefinir senha de ninguem.
 */
function criarTokenRedefinicao(usuario) {
  const token = tokenAleatorio(32);
  usuario.redefinicao = {
    tokenHash: hashToken(token),
    expiraEm: Date.now() + TTL_TOKEN_MS,
  };
  return token;
}

/** Valida e CONSOME o token (uso unico). Devolve o usuario ou null. */
function consumirTokenRedefinicao(token) {
  if (!token) return null;
  const alvoHash = hashToken(token);
  const dados = db.estado();

  for (const usuario of dados.usuarios) {
    const pendente = usuario.redefinicao;
    if (!pendente?.tokenHash) continue;

    // Comparacao em tempo constante, hash a hash.
    const bufA = Buffer.from(pendente.tokenHash, 'hex');
    const bufB = Buffer.from(alvoHash, 'hex');
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) continue;

    // Token achado: consome sempre, mesmo expirado — nao ha segunda chance.
    usuario.redefinicao = null;
    if (Date.now() > pendente.expiraEm) return null;
    if (usuario.ativo === false) return null;
    return usuario;
  }
  return null;
}

/**
 * POST /api/auth/esqueci — publica.
 *
 * A resposta e IDENTICA exista o e-mail ou nao: esta rota nao pode servir para
 * descobrir quais enderecos tem conta. Toda a variacao acontece do lado de ca.
 */
async function esqueciSenha(req, res) {
  const ip = ipCliente(req);
  const regra = limites.REGRAS.recuperacao;
  const porIp = limites.consumir(`esqueci:ip:${ip}`, regra.limite, regra.janelaMs);
  if (!porIp.permitido) {
    return erro(res, 429, 'Pedidos demais. Aguarde uma hora e tente de novo.');
  }

  const corpo = await lerJson(req);
  const emailPedido = texto(corpo.email, { campo: 'email', obrigatorio: true, max: 200 }).toLowerCase();

  const respostaGenerica = {
    ok: true,
    mensagem:
      'Se houver uma conta com este e-mail, um link de redefinicao foi enviado. ' +
      'Ele vale por 1 hora. Se nada chegar, procure seu gestor — ele pode redefinir a sua senha na aba Equipe.',
  };

  const porConta = limites.consumir(`esqueci:conta:${emailPedido}`, regra.limite, regra.janelaMs);
  if (!porConta.permitido) return json(res, 200, respostaGenerica);

  const dados = db.estado();
  const usuario = dados.usuarios.find((u) => u.email === emailPedido && u.ativo !== false);

  if (usuario && email.emailConfigurado()) {
    const token = criarTokenRedefinicao(usuario);
    const link = `${config.appUrl}/?redefinir=${encodeURIComponent(token)}`;
    try {
      await email.enviarSistema({
        para: usuario.email,
        paraNome: usuario.nome,
        assunto: 'Claves CRM — redefinicao de senha',
        corpo:
          `Ola, ${usuario.nome}.\n\n` +
          `Alguem (esperamos que voce) pediu para redefinir a senha da sua conta no Claves CRM.\n\n` +
          `Abra este link para escolher uma nova senha (vale por 1 hora, uso unico):\n\n${link}\n\n` +
          `Se nao foi voce, ignore este e-mail — sua senha continua a mesma.\n`,
      });
      db.registrarAuditoria({ tipo: 'recuperacao_solicitada', usuarioId: usuario.id, ip });
    } catch (falha) {
      // Falha de SMTP nao pode virar oraculo de existencia de conta. Anula o
      // token (o e-mail nao saiu), registra e responde o generico mesmo assim.
      usuario.redefinicao = null;
      console.error('[claves] falha ao enviar e-mail de recuperacao:', falha.message);
    }
    await db.salvar();
  }

  json(res, 200, respostaGenerica);
}

/** POST /api/auth/redefinir — publica. Token + nova senha. */
async function redefinirComToken(req, res) {
  const ip = ipCliente(req);
  const regra = limites.REGRAS.recuperacao;
  const controle = limites.consumir(`redefinir:ip:${ip}`, regra.limite, regra.janelaMs);
  if (!controle.permitido) {
    return erro(res, 429, 'Tentativas demais. Aguarde uma hora.');
  }

  const corpo = await lerJson(req);
  const token = String(corpo.token || '');
  const nova = String(corpo.novaSenha || '');

  if (nova.length < 12) {
    return erro(res, 400, 'A nova senha precisa ter no minimo 12 caracteres.');
  }

  const usuario = consumirTokenRedefinicao(token);
  await db.salvar(); // o consumo do token precisa persistir mesmo em caso de erro
  if (!usuario) {
    return erro(res, 400, 'Link invalido ou expirado. Peca um novo em "Esqueci minha senha".');
  }

  usuario.senhaHash = hashSenha(nova);
  usuario.trocaSenhaObrigatoria = false;
  sessao.destruirDoUsuario(usuario.id);
  db.registrarAuditoria({ tipo: 'senha_redefinida_por_token', usuarioId: usuario.id, ip });
  await db.salvar();

  json(res, 200, { ok: true, mensagem: 'Senha redefinida. Faca login com a nova senha.' });
}

module.exports = {
  bootstrapAdmin,
  login,
  logout,
  sessaoAtual,
  trocarSenha,
  usuarioPublico,
  esqueciSenha,
  redefinirComToken,
  criarTokenRedefinicao,
  consumirTokenRedefinicao,
};
