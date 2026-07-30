'use strict';

const db = require('../store/db');
const sessao = require('../security/sessao');
const limites = require('../security/limites');
const { hashSenha, verificarSenha, id: novoId } = require('../security/crypto');
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

module.exports = { bootstrapAdmin, login, logout, sessaoAtual, trocarSenha, usuarioPublico };
