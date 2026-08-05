'use strict';

/**
 * Integracao de e-mail.
 *
 * Modelo escolhido: UMA conta SMTP da empresa, configurada pelo admin, e o
 * `Reply-To` apontando para o e-mail do SDR que disparou. Assim a resposta do
 * decisor cai direto na caixa de quem esta tocando o lead, sem precisar que
 * cada SDR cadastre e mantenha credencial propria (o que multiplicaria segredo
 * guardado e quebraria quando alguem trocasse a senha do Google).
 *
 * Todo envio vira ATIVIDADE no lead. O historico e o que transforma o CRM em
 * memoria da operacao: quem falou o que, com quem e quando.
 *
 * NAO ha leitura de caixa de entrada (IMAP). O CRM envia e registra o que
 * enviou; respostas continuam no e-mail do SDR.
 */

const db = require('../store/db');
const smtp = require('../lib/smtp');
const papeis = require('../security/papeis');
const limites = require('../security/limites');
const { cifrar, decifrar, mascarar, id: novoId } = require('../security/crypto');
const { json, erro, lerJson, texto, umDe } = require('../lib/http');

const CONTEXTO_CRIPTO = 'integracao:email';

const TIPOS_ATIVIDADE = ['email', 'ligacao', 'reuniao', 'nota', 'linkedin', 'whatsapp'];

function configuracao() {
  return db.estado().configuracoes.integracoes?.email || null;
}

function emailConfigurado() {
  return Boolean(configuracao()?.senhaCifrada || configuracao()?.host);
}

function credencial() {
  const cfg = configuracao();
  if (!cfg?.host) return null;
  let senha = '';
  if (cfg.senhaCifrada) {
    try {
      senha = decifrar(cfg.senhaCifrada, CONTEXTO_CRIPTO);
    } catch {
      return null; // chave mestra trocada: a credencial virou lixo
    }
  }
  return {
    host: cfg.host,
    porta: cfg.porta,
    usuario: cfg.usuario || null,
    senha,
    remetenteEmail: cfg.remetenteEmail,
    remetenteNome: cfg.remetenteNome || null,
  };
}

// ------------------------------------------------------------- configuracao

function obterConfiguracao(req, res, contexto) {
  if (!papeis.podeConfigurarIntegracoes(contexto.usuario)) {
    return erro(res, 403, 'Apenas o administrador configura o e-mail.');
  }
  const cfg = configuracao();
  json(res, 200, {
    email: cfg
      ? {
          host: cfg.host,
          porta: cfg.porta,
          usuario: cfg.usuario || null,
          senhaMascarada: cfg.senhaMascarada || null,
          remetenteEmail: cfg.remetenteEmail,
          remetenteNome: cfg.remetenteNome || null,
          criadoEm: cfg.criadoEm,
        }
      : null,
  });
}

async function salvarConfiguracao(req, res, contexto) {
  if (!papeis.podeConfigurarIntegracoes(contexto.usuario)) {
    return erro(res, 403, 'Apenas o administrador configura o e-mail.');
  }

  const corpo = await lerJson(req);
  const host = texto(corpo.host, { campo: 'host', obrigatorio: true, max: 200 });
  const porta = Number(corpo.porta) || 587;
  const usuario = texto(corpo.usuario, { campo: 'usuario', max: 200 }) || null;
  const senha = String(corpo.senha || '');
  const remetenteEmail = texto(corpo.remetenteEmail, { campo: 'remetenteEmail', obrigatorio: true, max: 200 }).toLowerCase();
  const remetenteNome = texto(corpo.remetenteNome, { campo: 'remetenteNome', max: 120 }) || null;

  if (!smtp.validarEmail(remetenteEmail)) return erro(res, 400, 'E-mail do remetente invalido.');
  if (![25, 465, 587, 2525].includes(porta)) {
    return erro(res, 400, 'Porta SMTP invalida. Use 587 (STARTTLS) ou 465 (TLS).');
  }

  const dados = db.estado();
  const anterior = dados.configuracoes.integracoes.email;

  // Senha em branco mantem a que ja estava salva (permite editar o remetente
  // sem redigitar o segredo).
  let senhaCifrada = anterior?.senhaCifrada || null;
  let senhaMascarada = anterior?.senhaMascarada || null;
  if (senha) {
    senhaCifrada = cifrar(senha, CONTEXTO_CRIPTO);
    senhaMascarada = mascarar(senha);
  }
  if (usuario && !senhaCifrada) {
    return erro(res, 400, 'Informe a senha do usuario SMTP.');
  }

  dados.configuracoes.integracoes.email = {
    host,
    porta,
    usuario,
    senhaCifrada,
    senhaMascarada,
    remetenteEmail,
    remetenteNome,
    criadoEm: anterior?.criadoEm || new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
  };

  db.registrarAuditoria({ tipo: 'email_configurado', usuarioId: contexto.usuario.id, host });
  await db.salvar();

  json(res, 200, { ok: true, host, porta, remetenteEmail });
}

async function removerConfiguracao(req, res, contexto) {
  if (!papeis.podeConfigurarIntegracoes(contexto.usuario)) {
    return erro(res, 403, 'Apenas o administrador configura o e-mail.');
  }
  const dados = db.estado();
  dados.configuracoes.integracoes.email = null;
  await db.salvar();
  json(res, 200, { ok: true });
}

async function testarConfiguracao(req, res, contexto) {
  if (!papeis.podeConfigurarIntegracoes(contexto.usuario)) {
    return erro(res, 403, 'Apenas o administrador testa o e-mail.');
  }
  const controle = limites.consumir(
    `smtp-teste:${contexto.usuario.id}`,
    limites.REGRAS.testeLlm.limite,
    limites.REGRAS.testeLlm.janelaMs
  );
  if (!controle.permitido) return erro(res, 429, 'Muitos testes seguidos. Aguarde alguns minutos.');

  const cred = credencial();
  if (!cred) return erro(res, 400, 'Configure o servidor SMTP antes de testar.');

  try {
    await smtp.testarConexao(cred);
    json(res, 200, { ok: true, mensagem: `Conexao e autenticacao OK em ${cred.host}:${cred.porta}.` });
  } catch (falha) {
    erro(res, 400, falha.message);
  }
}

// ------------------------------------------------------------------- envio

/**
 * Envia e-mail para um decisor do lead e registra a atividade.
 * O lead precisa estar no escopo de quem envia (checado por `leadNoEscopo`,
 * injetado por quem monta a rota para nao duplicar a regra de visibilidade).
 */
function criarEnviar({ leadNoEscopo }) {
  return async function enviar(req, res, contexto) {
    const escopo = leadNoEscopo(contexto);
    if (escopo.erro) return erro(res, escopo.erro, escopo.mensagem);
    const { lead, dados } = escopo;

    const cred = credencial();
    if (!cred) {
      return erro(res, 400, 'Nenhum servidor de e-mail configurado. Peca ao administrador para cadastrar em Configuracoes.');
    }

    const controle = limites.consumir(
      `email:${contexto.usuario.id}`,
      limites.REGRAS.pesquisa.limite,
      limites.REGRAS.pesquisa.janelaMs
    );
    if (!controle.permitido) {
      return erro(res, 429, 'Limite de envios por hora atingido.');
    }

    const corpoReq = await lerJson(req);
    const assunto = texto(corpoReq.assunto, { campo: 'assunto', obrigatorio: true, max: 300 });
    const mensagem = texto(corpoReq.corpo, { campo: 'corpo', obrigatorio: true, max: 20000 });

    // O destino sai SEMPRE de um contato ja gravado no lead. Nao aceitamos
    // e-mail solto do cliente: isso impediria usar o CRM como relay de spam.
    const contatoId = String(corpoReq.contatoId || '');
    const contato = dados.contatos.find((c) => c.id === contatoId && c.leadId === lead.id);
    if (!contato) return erro(res, 404, 'Contato nao encontrado neste lead.');
    if (!contato.emailPublico) {
      return erro(res, 400, `${contato.nomeCompleto} nao tem e-mail publico registrado. Cadastre o e-mail no contato antes de enviar.`);
    }

    let resultado;
    try {
      resultado = await smtp.enviar({
        host: cred.host,
        porta: cred.porta,
        usuario: cred.usuario,
        senha: cred.senha,
        de: cred.remetenteEmail,
        deNome: cred.remetenteNome || contexto.usuario.nome,
        para: contato.emailPublico,
        paraNome: contato.nomeCompleto,
        // A resposta volta para quem esta tocando o lead, nao para a caixa geral.
        responderPara: contexto.usuario.email,
        assunto,
        corpo: mensagem,
      });
    } catch (falha) {
      return erro(res, 502, `Falha ao enviar: ${falha.message}`);
    }

    const atividade = {
      id: novoId('atv'),
      leadId: lead.id,
      contatoId: contato.id,
      tipo: 'email',
      em: new Date().toISOString(),
      usuarioId: contexto.usuario.id,
      usuarioNome: contexto.usuario.nome,
      para: contato.emailPublico,
      assunto,
      resumo: mensagem.slice(0, 2000),
      idMensagem: resultado.idMensagem,
    };
    dados.atividades.push(atividade);

    // Enviar e-mail move o lead de "novo" para "contatado": o kanban precisa
    // refletir o que de fato aconteceu, sem o SDR ter que arrastar o cartao.
    if (lead.status === 'novo') lead.status = 'contatado';
    lead.atualizadoEm = atividade.em;

    db.registrarAuditoria({
      tipo: 'email_enviado',
      usuarioId: contexto.usuario.id,
      leadId: lead.id,
      contatoId: contato.id,
    });
    await db.salvar();

    json(res, 200, { ok: true, atividade, statusLead: lead.status });
  };
}

/** Registro manual de contato (ligacao, reuniao, nota, LinkedIn, WhatsApp). */
function criarRegistrarAtividade({ leadNoEscopo }) {
  return async function registrar(req, res, contexto) {
    const escopo = leadNoEscopo(contexto);
    if (escopo.erro) return erro(res, escopo.erro, escopo.mensagem);
    const { lead, dados } = escopo;

    const corpo = await lerJson(req);
    const tipo = umDe(corpo.tipo, TIPOS_ATIVIDADE, null);
    if (!tipo) return erro(res, 400, `Tipo invalido. Use um de: ${TIPOS_ATIVIDADE.join(', ')}.`);
    if (tipo === 'email') {
      return erro(res, 400, 'E-mail e registrado automaticamente pelo envio.');
    }

    const resumo = texto(corpo.resumo, { campo: 'resumo', obrigatorio: true, max: 4000 });

    let contatoId = null;
    if (corpo.contatoId) {
      const contato = dados.contatos.find((c) => c.id === String(corpo.contatoId) && c.leadId === lead.id);
      if (!contato) return erro(res, 404, 'Contato nao encontrado neste lead.');
      contatoId = contato.id;
    }

    const atividade = {
      id: novoId('atv'),
      leadId: lead.id,
      contatoId,
      tipo,
      em: new Date().toISOString(),
      usuarioId: contexto.usuario.id,
      usuarioNome: contexto.usuario.nome,
      resumo,
    };
    dados.atividades.push(atividade);

    if (lead.status === 'novo') lead.status = 'contatado';
    lead.atualizadoEm = atividade.em;
    await db.salvar();

    json(res, 201, { atividade, statusLead: lead.status });
  };
}

module.exports = {
  CONTEXTO_CRIPTO,
  TIPOS_ATIVIDADE,
  emailConfigurado,
  obterConfiguracao,
  salvarConfiguracao,
  removerConfiguracao,
  testarConfiguracao,
  criarEnviar,
  criarRegistrarAtividade,
};
