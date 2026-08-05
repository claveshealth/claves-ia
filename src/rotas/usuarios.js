'use strict';

/**
 * Cadastro de equipe: admin, gestor e SDR.
 *
 * Regras que existem para o sistema nao se trancar sozinho nem permitir
 * escalada de privilegio:
 *
 *  - Gestor cria e desativa apenas SDR. Nao promove ninguem a gestor/admin.
 *  - Ninguem muda o proprio papel, se desativa ou reseta a propria senha por
 *    aqui (para a propria senha existe /api/auth/senha, que pede a senha atual).
 *  - Sempre tem de restar ao menos um admin ativo.
 *  - Usuario nao e apagado: e desativado. Apagar orfanaria os leads dos quais
 *    ele e dono e o historico de atividades. Para tirar alguem da operacao,
 *    desative e reatribua os leads.
 */

const db = require('../store/db');
const sessao = require('../security/sessao');
const papeis = require('../security/papeis');
const { hashSenha, id: novoId } = require('../security/crypto');
const { json, erro, lerJson, texto, umDe } = require('../lib/http');

const MIN_SENHA = 12;

function publico(usuario, dados) {
  const leadsDoUsuario = dados.leads.filter((l) => l.dono === usuario.id && l.status !== 'descartado');
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    ativo: usuario.ativo !== false,
    criadoEm: usuario.criadoEm,
    ultimoLogin: usuario.ultimoLogin || null,
    leadsAtivos: leadsDoUsuario.length,
  };
}

function adminsAtivos(dados, excetoId = null) {
  return dados.usuarios.filter(
    (u) => u.papel === 'admin' && u.ativo !== false && u.id !== excetoId
  );
}

function emailValido(valor) {
  // Validacao deliberadamente simples: o que importa aqui e formato basico e
  // unicidade. Confirmacao real de caixa e feita pelo envio.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor);
}

function listar(req, res, contexto) {
  if (!papeis.podeGerenciarUsuarios(contexto.usuario)) {
    return erro(res, 403, 'Apenas gestor ou administrador pode ver a equipe.');
  }
  const dados = db.estado();
  const equipe = dados.usuarios
    .map((u) => publico(u, dados))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  json(res, 200, {
    usuarios: equipe,
    papeisQuePodeAtribuir: papeis.papeisQuePodeAtribuir(contexto.usuario),
    descricaoPapeis: papeis.DESCRICAO,
  });
}

async function criar(req, res, contexto) {
  if (!papeis.podeGerenciarUsuarios(contexto.usuario)) {
    return erro(res, 403, 'Apenas gestor ou administrador pode cadastrar pessoas.');
  }

  const corpo = await lerJson(req);
  const nome = texto(corpo.nome, { campo: 'nome', obrigatorio: true, max: 120 });
  const email = texto(corpo.email, { campo: 'email', obrigatorio: true, max: 200 }).toLowerCase();
  const papel = umDe(corpo.papel, papeis.PAPEIS, null);
  const senha = String(corpo.senha || '');

  if (!emailValido(email)) return erro(res, 400, 'E-mail invalido.');
  if (!papel) return erro(res, 400, 'Informe um papel valido (admin, gestor ou sdr).');
  if (!papeis.podeAtribuirPapel(contexto.usuario, papel)) {
    return erro(
      res,
      403,
      `Seu papel permite cadastrar apenas: ${papeis.papeisQuePodeAtribuir(contexto.usuario).join(', ') || 'nenhum'}.`
    );
  }
  if (senha.length < MIN_SENHA) {
    return erro(res, 400, `A senha inicial precisa ter no minimo ${MIN_SENHA} caracteres.`);
  }

  const dados = db.estado();
  if (dados.usuarios.some((u) => u.email === email)) {
    return erro(res, 409, 'Ja existe um usuario com este e-mail.');
  }

  const usuario = {
    id: novoId('usr'),
    nome,
    email,
    papel,
    ativo: true,
    senhaHash: hashSenha(senha),
    trocaSenhaObrigatoria: true, // senha foi definida por outra pessoa
    criadoEm: new Date().toISOString(),
    criadoPor: contexto.usuario.id,
    ultimoLogin: null,
  };
  dados.usuarios.push(usuario);

  db.registrarAuditoria({
    tipo: 'usuario_criado',
    usuarioId: contexto.usuario.id,
    alvoId: usuario.id,
    papel,
  });
  await db.salvar();

  json(res, 201, { usuario: publico(usuario, dados) });
}

async function atualizar(req, res, contexto) {
  if (!papeis.podeGerenciarUsuarios(contexto.usuario)) {
    return erro(res, 403, 'Apenas gestor ou administrador pode editar a equipe.');
  }

  const dados = db.estado();
  const alvo = dados.usuarios.find((u) => u.id === contexto.parametros.id);
  if (!alvo) return erro(res, 404, 'Usuario nao encontrado.');

  // Gestor nao mexe em admin nem em outro gestor.
  if (contexto.usuario.papel === 'gestor' && alvo.papel !== 'sdr') {
    return erro(res, 403, 'Gestor pode editar apenas SDR.');
  }

  const corpo = await lerJson(req);
  const proprio = papeis.eProprioUsuario(contexto.usuario, alvo.id);

  if (corpo.nome !== undefined) {
    alvo.nome = texto(corpo.nome, { campo: 'nome', obrigatorio: true, max: 120 });
  }

  if (corpo.papel !== undefined && corpo.papel !== alvo.papel) {
    if (proprio) return erro(res, 403, 'Voce nao pode mudar o seu proprio papel.');
    const papel = umDe(corpo.papel, papeis.PAPEIS, null);
    if (!papel) return erro(res, 400, 'Papel invalido.');
    if (!papeis.podeAtribuirPapel(contexto.usuario, papel)) {
      return erro(res, 403, 'Seu papel nao permite atribuir esse papel.');
    }
    // Rebaixar o ultimo admin deixaria o sistema sem administrador.
    if (alvo.papel === 'admin' && papel !== 'admin' && adminsAtivos(dados, alvo.id).length === 0) {
      return erro(res, 409, 'Este e o unico administrador ativo. Promova outro antes de rebaixar.');
    }
    alvo.papel = papel;
  }

  if (corpo.ativo !== undefined) {
    const ativo = corpo.ativo === true;
    if (!ativo && proprio) return erro(res, 403, 'Voce nao pode desativar a sua propria conta.');
    if (!ativo && alvo.papel === 'admin' && adminsAtivos(dados, alvo.id).length === 0) {
      return erro(res, 409, 'Este e o unico administrador ativo. Promova outro antes de desativar.');
    }
    alvo.ativo = ativo;
    // Desativar derruba as sessoes na hora — nao espera expirar.
    if (!ativo) sessao.destruirDoUsuario(alvo.id);
  }

  db.registrarAuditoria({
    tipo: 'usuario_atualizado',
    usuarioId: contexto.usuario.id,
    alvoId: alvo.id,
  });
  await db.salvar();

  json(res, 200, { usuario: publico(alvo, dados) });
}

/**
 * Reset de senha por gestor/admin. Nao devolve a senha: quem reseta digita a
 * nova e comunica pelo canal que quiser. Marca troca obrigatoria e derruba as
 * sessoes do alvo.
 */
async function redefinirSenha(req, res, contexto) {
  if (!papeis.podeGerenciarUsuarios(contexto.usuario)) {
    return erro(res, 403, 'Apenas gestor ou administrador pode redefinir senha.');
  }

  const dados = db.estado();
  const alvo = dados.usuarios.find((u) => u.id === contexto.parametros.id);
  if (!alvo) return erro(res, 404, 'Usuario nao encontrado.');

  if (papeis.eProprioUsuario(contexto.usuario, alvo.id)) {
    return erro(res, 400, 'Para trocar a sua propria senha use a tela de conta (pede a senha atual).');
  }
  if (contexto.usuario.papel === 'gestor' && alvo.papel !== 'sdr') {
    return erro(res, 403, 'Gestor pode redefinir senha apenas de SDR.');
  }

  const corpo = await lerJson(req);
  const nova = String(corpo.novaSenha || '');
  if (nova.length < MIN_SENHA) {
    return erro(res, 400, `A senha precisa ter no minimo ${MIN_SENHA} caracteres.`);
  }

  alvo.senhaHash = hashSenha(nova);
  alvo.trocaSenhaObrigatoria = true;
  sessao.destruirDoUsuario(alvo.id);

  db.registrarAuditoria({
    tipo: 'senha_redefinida_por_gestor',
    usuarioId: contexto.usuario.id,
    alvoId: alvo.id,
  });
  await db.salvar();

  json(res, 200, {
    ok: true,
    mensagem: `Senha de ${alvo.nome} redefinida. As sessoes dele foram encerradas e a troca sera exigida no proximo login.`,
  });
}

/**
 * Transfere todos os leads de um usuario para outro. E o passo que torna a
 * desativacao segura: o pipeline nao fica orfao quando alguem sai.
 */
async function transferirLeads(req, res, contexto) {
  if (!papeis.podeReatribuirLead(contexto.usuario)) {
    return erro(res, 403, 'Apenas gestor ou administrador pode transferir leads.');
  }

  const corpo = await lerJson(req);
  const dados = db.estado();

  const origem = dados.usuarios.find((u) => u.id === contexto.parametros.id);
  if (!origem) return erro(res, 404, 'Usuario de origem nao encontrado.');

  const destinoId = String(corpo.paraUsuarioId || '');
  const destino = dados.usuarios.find((u) => u.id === destinoId);
  if (!destino) return erro(res, 404, 'Usuario de destino nao encontrado.');
  if (destino.ativo === false) return erro(res, 400, 'O destino esta desativado.');
  if (destino.id === origem.id) return erro(res, 400, 'Origem e destino sao o mesmo usuario.');

  let transferidos = 0;
  for (const lead of dados.leads) {
    if (lead.dono === origem.id) {
      lead.dono = destino.id;
      lead.atualizadoEm = new Date().toISOString();
      transferidos += 1;
    }
  }

  db.registrarAuditoria({
    tipo: 'leads_transferidos',
    usuarioId: contexto.usuario.id,
    deId: origem.id,
    paraId: destino.id,
    quantidade: transferidos,
  });
  await db.salvar();

  json(res, 200, {
    ok: true,
    transferidos,
    mensagem: `${transferidos} lead(s) movido(s) de ${origem.nome} para ${destino.nome}.`,
  });
}

module.exports = { listar, criar, atualizar, redefinirSenha, transferirLeads, MIN_SENHA };
