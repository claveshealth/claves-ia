'use strict';

const db = require('../store/db');
const llm = require('../llm');
const icp = require('../agentes/icp');
const orquestrador = require('../agentes/orquestrador');
const buscaWeb = require('../fontes/buscaWeb');
const linkedin = require('../fontes/linkedin');
const email = require('./email');
const limites = require('../security/limites');
const papeis = require('../security/papeis');
const { cifrar, mascarar, id: novoId } = require('../security/crypto');
const { json, erro, lerJson, texto, umDe } = require('../lib/http');
const config = require('../config');

// ------------------------------------------------------------ escopo de lead

/**
 * Regra central de visibilidade: o lead pertence ao SDR que disparou a
 * pesquisa. SDR ve e mexe apenas no proprio kanban; gestor e admin veem o
 * pipeline da equipe inteira e podem reatribuir.
 */
function visivelPara(lead, usuario) {
  if (papeis.podeVerTodosLeads(usuario)) return true;
  return lead.dono === usuario.id;
}

function nomeDono(dados, donoId) {
  if (!donoId) return null;
  const dono = dados.usuarios.find((u) => u.id === donoId);
  return dono ? dono.nome || dono.email : null;
}

/** Busca o lead respeitando o escopo; devolve null quando nao pode ser visto. */
function leadNoEscopo(contexto) {
  const dados = db.estado();
  const lead = dados.leads.find((l) => l.id === contexto.parametros.id);
  if (!lead) return { erro: 404, mensagem: 'Lead nao encontrado.' };
  if (!visivelPara(lead, contexto.usuario)) {
    // 404 em vez de 403: nao revelamos a existencia de lead de outro SDR.
    return { erro: 404, mensagem: 'Lead nao encontrado.' };
  }
  return { lead, dados };
}

// Execucoes em andamento por usuario (para limitar concorrencia e cancelar).
const execucoesAtivas = new Map(); // usuarioId -> Set<AbortController>

// ---------------------------------------------------------------- metadados

function metadados(req, res, contexto) {
  json(res, 200, {
    papeis: papeis.PAPEIS,
    descricaoPapeis: papeis.DESCRICAO,
    permissoes: {
      verTodosLeads: papeis.podeVerTodosLeads(contexto.usuario),
      reatribuirLead: papeis.podeReatribuirLead(contexto.usuario),
      gerenciarUsuarios: papeis.podeGerenciarUsuarios(contexto.usuario),
      configurarIntegracoes: papeis.podeConfigurarIntegracoes(contexto.usuario),
      papeisQuePodeAtribuir: papeis.papeisQuePodeAtribuir(contexto.usuario),
    },
    buscaLinkedinDisponivel: buscaWeb.buscaDisponivel(),
    emailConfigurado: email.emailConfigurado(),
    cargosDecisores: linkedin.CARGOS_DECISORES,
    tiers: Object.values(icp.TIERS).map((t) => ({
      id: t.id,
      nome: t.nome,
      resumo: t.resumo,
      dorReal: t.dorReal,
      sinaisDeCompra: t.sinaisDeCompra,
      decisores: t.decisores,
      ondeCacar: t.ondeCacar,
      clienteEspelho: t.clienteEspelho,
    })),
    antiPersona: icp.ANTI_PERSONA.map((a) => ({
      codigo: a.codigo,
      titulo: a.titulo,
      porque: a.porque,
    })),
    status: icp.STATUS_LEAD,
    profundidades: Object.keys(orquestrador.PERFIS_PROFUNDIDADE),
    provedoresLlm: llm.listarProvedores(),
    provedoresBusca: Object.entries(buscaWeb.PROVEDORES_BUSCA).map(([id, p]) => ({
      id,
      nome: p.nome,
    })),
  });
}

// -------------------------------------------------------------------- leads

function listarLeads(req, res, contexto) {
  const params = contexto.url.searchParams;
  const dados = db.estado();

  const filtroTier = params.get('tier');
  const filtroStatus = params.get('status');
  const filtroBusca = (params.get('q') || '').toLowerCase().trim();
  const incluirDescartados = params.get('descartados') === '1';

  let leads = dados.leads.filter((l) => visivelPara(l, contexto.usuario));

  // Gestor/admin podem focar o pipeline de um SDR especifico.
  const filtroDono = params.get('dono');
  if (filtroDono && papeis.podeVerTodosLeads(contexto.usuario)) {
    leads = leads.filter((l) => (filtroDono === 'sem_dono' ? !l.dono : l.dono === filtroDono));
  }

  if (!incluirDescartados) leads = leads.filter((l) => l.status !== 'descartado');
  if (filtroTier) leads = leads.filter((l) => String(l.tier) === filtroTier);
  if (filtroStatus) leads = leads.filter((l) => l.status === filtroStatus);
  if (filtroBusca) {
    leads = leads.filter((l) => {
      const alvo = [
        l.empresa?.nome,
        l.empresa?.segmento,
        l.empresa?.cidade,
        l.empresa?.uf,
        l.porqueClaves,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return alvo.includes(filtroBusca);
    });
  }

  leads.sort((a, b) => (b.score || 0) - (a.score || 0));

  const contatosPorLead = new Map();
  for (const contato of dados.contatos) {
    if (!contatosPorLead.has(contato.leadId)) contatosPorLead.set(contato.leadId, 0);
    contatosPorLead.set(contato.leadId, contatosPorLead.get(contato.leadId) + 1);
  }

  // O resumo respeita o mesmo escopo da listagem: SDR nunca ve contagem que
  // inclua lead de outro. Por isso parte do universo visivel, nao de dados.leads.
  const universo = dados.leads.filter((l) => visivelPara(l, contexto.usuario));

  json(res, 200, {
    total: leads.length,
    escopo: papeis.podeVerTodosLeads(contexto.usuario) ? 'equipe' : 'proprio',
    leads: leads.map((l) => ({
      id: l.id,
      empresa: l.empresa,
      tier: l.tier,
      score: l.score,
      status: l.status,
      confianca: l.confianca,
      porqueClaves: l.porqueClaves,
      volumeEstimadoVagas: l.volumeEstimadoVagas,
      totalSinais: (l.sinaisDeCompra || []).length,
      totalDecisores: contatosPorLead.get(l.id) || 0,
      antiPersona: l.antiPersona,
      dono: l.dono || null,
      donoNome: nomeDono(dados, l.dono),
      criadoEm: l.criadoEm,
      atualizadoEm: l.atualizadoEm,
    })),
    resumo: {
      total: universo.length,
      porTier: [1, 2, 3, 4].map((t) => ({
        tier: t,
        quantidade: universo.filter((l) => l.tier === t && l.status !== 'descartado').length,
      })),
      porStatus: icp.STATUS_LEAD.map((s) => ({
        status: s,
        quantidade: universo.filter((l) => l.status === s).length,
      })),
      descartados: universo.filter((l) => l.status === 'descartado').length,
    },
  });
}

/**
 * Kanban: os leads visiveis agrupados por status, na ordem do funil.
 * E a tela onde o SDR trabalha o que a pesquisa dele trouxe.
 */
function kanban(req, res, contexto) {
  const dados = db.estado();
  const params = contexto.url.searchParams;

  let leads = dados.leads.filter((l) => visivelPara(l, contexto.usuario));

  const filtroDono = params.get('dono');
  if (filtroDono && papeis.podeVerTodosLeads(contexto.usuario)) {
    leads = leads.filter((l) => (filtroDono === 'sem_dono' ? !l.dono : l.dono === filtroDono));
  }

  // "descartado" nao e coluna de trabalho: fica fora do quadro por padrao.
  const colunas = icp.STATUS_LEAD.filter((s) => s !== 'descartado');

  const cartao = (l) => ({
    id: l.id,
    empresa: l.empresa?.nome || null,
    cidade: l.empresa?.cidade || null,
    uf: l.empresa?.uf || null,
    tier: l.tier,
    score: l.score,
    status: l.status,
    volumeEstimadoVagas: l.volumeEstimadoVagas,
    totalDecisores: dados.contatos.filter((c) => c.leadId === l.id).length,
    ganchoAbordagem: l.ganchoAbordagem || null,
    dono: l.dono || null,
    donoNome: nomeDono(dados, l.dono),
    atualizadoEm: l.atualizadoEm,
  });

  json(res, 200, {
    escopo: papeis.podeVerTodosLeads(contexto.usuario) ? 'equipe' : 'proprio',
    colunas: colunas.map((status) => {
      const doStatus = leads
        .filter((l) => l.status === status)
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      return { status, total: doStatus.length, cartoes: doStatus.map(cartao) };
    }),
    descartados: leads.filter((l) => l.status === 'descartado').length,
  });
}

/** Reatribui o lead a outro SDR. Ato de gestao: gestor e admin apenas. */
async function reatribuirLead(req, res, contexto) {
  if (!papeis.podeReatribuirLead(contexto.usuario)) {
    return erro(res, 403, 'Apenas gestor ou administrador pode reatribuir lead.');
  }

  const dados = db.estado();
  const lead = dados.leads.find((l) => l.id === contexto.parametros.id);
  if (!lead) return erro(res, 404, 'Lead nao encontrado.');

  const corpo = await lerJson(req);
  const donoId = corpo.dono === null ? null : String(corpo.dono || '');

  if (donoId) {
    const novoDono = dados.usuarios.find((u) => u.id === donoId);
    if (!novoDono) return erro(res, 404, 'Usuario de destino nao encontrado.');
    if (novoDono.ativo === false) return erro(res, 400, 'Nao da para atribuir lead a conta desativada.');
    lead.dono = novoDono.id;
  } else {
    lead.dono = null;
  }

  lead.atualizadoEm = new Date().toISOString();
  db.registrarAuditoria({
    tipo: 'lead_reatribuido',
    usuarioId: contexto.usuario.id,
    leadId: lead.id,
    paraId: lead.dono,
  });
  await db.salvar();

  json(res, 200, { ok: true, dono: lead.dono, donoNome: nomeDono(dados, lead.dono) });
}

function obterLead(req, res, contexto) {
  const escopo = leadNoEscopo(contexto);
  if (escopo.erro) return erro(res, escopo.erro, escopo.mensagem);
  const { lead, dados } = escopo;

  const contatos = dados.contatos.filter((c) => c.leadId === lead.id);
  const atividades = (dados.atividades || [])
    .filter((a) => a.leadId === lead.id)
    .sort((a, b) => String(b.em).localeCompare(String(a.em)));

  json(res, 200, {
    lead: { ...lead, donoNome: nomeDono(dados, lead.dono) },
    contatos,
    atividades,
  });
}

async function atualizarLead(req, res, contexto) {
  const escopo = leadNoEscopo(contexto);
  if (escopo.erro) return erro(res, escopo.erro, escopo.mensagem);
  const { lead } = escopo;

  const corpo = await lerJson(req);

  if (corpo.status !== undefined) {
    const novoStatus = umDe(corpo.status, icp.STATUS_LEAD, null);
    if (!novoStatus) return erro(res, 400, 'Status invalido.');
    lead.status = novoStatus;
  }
  if (corpo.nota !== undefined) {
    const nota = texto(corpo.nota, { campo: 'nota', max: 4000 });
    if (nota) {
      lead.notas = lead.notas || [];
      lead.notas.push({
        em: new Date().toISOString(),
        autor: contexto.usuario.nome || contexto.usuario.email,
        texto: nota,
      });
    }
  }

  lead.atualizadoEm = new Date().toISOString();
  await db.salvar();
  json(res, 200, { lead });
}

async function removerLead(req, res, contexto) {
  const escopo = leadNoEscopo(contexto);
  if (escopo.erro) return erro(res, escopo.erro, escopo.mensagem);
  const dados = escopo.dados;

  dados.leads = dados.leads.filter((l) => l.id !== contexto.parametros.id);
  dados.contatos = dados.contatos.filter((c) => c.leadId !== contexto.parametros.id);
  dados.atividades = (dados.atividades || []).filter((a) => a.leadId !== contexto.parametros.id);
  db.registrarAuditoria({ tipo: 'lead_removido', usuarioId: contexto.usuario.id, leadId: contexto.parametros.id });
  await db.salvar();
  json(res, 200, { ok: true });
}

function csvEscapar(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  // Prefixo defensivo contra injecao de formula em planilhas.
  const seguro = /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
  return `"${seguro.replace(/"/g, '""')}"`;
}

function exportarCsv(req, res, contexto) {
  const dados = db.estado();
  const colunas = [
    'empresa', 'tier', 'score', 'status', 'confianca', 'cidade', 'uf', 'site',
    'segmento', 'vagas_estimadas', 'dono', 'porque_claves', 'gancho', 'decisor_nome',
    'decisor_cargo', 'decisor_linkedin', 'decisor_fonte', 'decisor_status_atual',
  ];
  const linhas = [colunas.join(',')];

  // A exportacao respeita o escopo: SDR leva o proprio kanban, nao a base toda.
  for (const lead of dados.leads) {
    if (lead.status === 'descartado') continue;
    if (!visivelPara(lead, contexto.usuario)) continue;
    const contatos = dados.contatos.filter((c) => c.leadId === lead.id);
    const base = [
      lead.empresa?.nome, lead.tier, lead.score, lead.status, lead.confianca,
      lead.empresa?.cidade, lead.empresa?.uf, lead.empresa?.site,
      lead.empresa?.segmento, lead.volumeEstimadoVagas, nomeDono(dados, lead.dono),
      lead.porqueClaves, lead.ganchoAbordagem,
    ];
    if (!contatos.length) {
      linhas.push([...base, '', '', '', '', ''].map(csvEscapar).join(','));
      continue;
    }
    for (const contato of contatos) {
      linhas.push(
        [...base, contato.nomeCompleto, contato.cargo, contato.linkedinUrl, contato.fonteUrl, contato.statusAtual]
          .map(csvEscapar)
          .join(',')
      );
    }
  }

  const corpo = `﻿${linhas.join('\r\n')}`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="claves-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store',
  });
  res.end(corpo);
}

// -------------------------------------------------------- decisores/LinkedIn

/**
 * Busca decisores da empresa do lead em perfis publicos do LinkedIn.
 * NAO grava: devolve os candidatos para a pessoa escolher. Gravar automatico
 * encheria a base de perfil errado — o julgamento fica com quem vai ligar.
 */
async function buscarDecisores(req, res, contexto) {
  const escopo = leadNoEscopo(contexto);
  if (escopo.erro) return erro(res, escopo.erro, escopo.mensagem);
  const { lead } = escopo;

  const controle = limites.consumir(
    `linkedin:${contexto.usuario.id}`,
    limites.REGRAS.testeLlm.limite,
    limites.REGRAS.testeLlm.janelaMs
  );
  if (!controle.permitido) {
    return erro(res, 429, 'Muitas buscas de decisor seguidas. Aguarde alguns minutos.');
  }

  const params = contexto.url.searchParams;
  const cargosParam = params.get('cargos');
  const cargos = cargosParam
    ? cargosParam.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 6)
    : [];

  try {
    const resultado = await linkedin.buscarPessoas({
      empresa: lead.empresa?.nome,
      cargos,
      regiao: lead.empresa?.uf || lead.empresa?.cidade || null,
    });
    // Marca quem ja esta na base para a UI nao oferecer duplicata.
    const jaSalvos = new Set(
      escopo.dados.contatos
        .filter((c) => c.leadId === lead.id && c.linkedinUrl)
        .map((c) => c.linkedinUrl)
    );
    json(res, 200, {
      ...resultado,
      pessoas: resultado.pessoas.map((p) => ({ ...p, jaSalvo: jaSalvos.has(p.linkedinUrl) })),
    });
  } catch (falha) {
    erro(res, 400, falha.message);
  }
}

/** Grava um decisor escolhido a mao (a partir da busca ou digitado). */
async function criarContato(req, res, contexto) {
  const escopo = leadNoEscopo(contexto);
  if (escopo.erro) return erro(res, escopo.erro, escopo.mensagem);
  const { lead, dados } = escopo;

  const corpo = await lerJson(req);
  const nomeCompleto = texto(corpo.nomeCompleto, { campo: 'nomeCompleto', obrigatorio: true, max: 200 });
  const cargo = texto(corpo.cargo, { campo: 'cargo', obrigatorio: true, max: 200 });

  const linkedinUrl = texto(corpo.linkedinUrl, { campo: 'linkedinUrl', max: 400 }) || null;
  if (linkedinUrl && dados.contatos.some((c) => c.leadId === lead.id && c.linkedinUrl === linkedinUrl)) {
    return erro(res, 409, 'Este perfil ja esta salvo neste lead.');
  }

  const contato = {
    id: novoId('ctt'),
    leadId: lead.id,
    nomeCompleto,
    cargo,
    area: umDe(corpo.area, ['operacoes_medicas', 'medico', 'rh_gente', 'executivo_ceo', 'expansao', 'unidade', 'outro'], 'outro'),
    senioridade: umDe(corpo.senioridade, ['c_level', 'diretoria', 'gerencia', 'coordenacao', 'outro'], 'outro'),
    linkedinUrl,
    emailPublico: texto(corpo.emailPublico, { campo: 'emailPublico', max: 200 }) || null,
    telefonePublico: texto(corpo.telefonePublico, { campo: 'telefonePublico', max: 60 }) || null,
    fonteUrl: texto(corpo.fonteUrl, { campo: 'fonteUrl', max: 400 }) || linkedinUrl,
    fonteTitulo: texto(corpo.fonteTitulo, { campo: 'fonteTitulo', max: 300 }) || null,
    dataDaEvidencia: texto(corpo.dataDaEvidencia, { campo: 'dataDaEvidencia', max: 20 }) || null,
    statusAtual: umDe(
      corpo.statusAtual,
      ['confirmado_atual', 'provavel_atual', 'nao_confirmado', 'saiu_da_empresa'],
      'nao_confirmado'
    ),
    trechoEvidencia: texto(corpo.trechoEvidencia, { campo: 'trechoEvidencia', max: 400 }) || null,
    confianca: umDe(corpo.confianca, ['alta', 'media', 'baixa'], 'media'),
    criadoEm: new Date().toISOString(),
    criadoPor: contexto.usuario.id,
    origem: 'manual',
  };

  // Coerente com a pesquisa automatica: quem saiu da empresa nao entra na base.
  if (contato.statusAtual === 'saiu_da_empresa') {
    return erro(res, 400, 'Nao gravamos contato marcado como "saiu da empresa".');
  }

  dados.contatos.push(contato);
  lead.atualizadoEm = contato.criadoEm;
  await db.salvar();

  json(res, 201, { contato });
}

async function removerContato(req, res, contexto) {
  const dados = db.estado();
  const contato = dados.contatos.find((c) => c.id === contexto.parametros.contatoId);
  if (!contato) return erro(res, 404, 'Contato nao encontrado.');

  const lead = dados.leads.find((l) => l.id === contato.leadId);
  if (!lead || !visivelPara(lead, contexto.usuario)) {
    return erro(res, 404, 'Contato nao encontrado.');
  }

  dados.contatos = dados.contatos.filter((c) => c.id !== contato.id);
  await db.salvar();
  json(res, 200, { ok: true });
}

// ------------------------------------------------------------ configuracoes

function listarConfiguracoes(req, res, contexto) {
  // Nao-admin recebe 200 com o conteudo sensivel vazio, em vez de 403: esta
  // rota e chamada no boot do app, e negar aqui derrubaria a inicializacao
  // inteira para SDR e gestor — que ainda precisam da tela para trocar a
  // propria senha.
  if (!papeis.podeConfigurarIntegracoes(contexto.usuario)) {
    return json(res, 200, {
      credenciais: [],
      provedores: llm.listarProvedores(),
      buscaWeb: null,
      chaveMestraEfemera: false,
      somenteLeitura: true,
    });
  }
  const integracoes = db.estado().configuracoes.integracoes || {};
  json(res, 200, {
    credenciais: llm.listarCredenciais(),
    provedores: llm.listarProvedores(),
    buscaWeb: integracoes.buscaWeb
      ? { provedor: integracoes.buscaWeb.provedor, chaveMascarada: integracoes.buscaWeb.chaveMascarada }
      : null,
    chaveMestraEfemera: config.chaveMestraEfemera,
  });
}

async function criarCredencial(req, res, contexto) {
  const corpo = await lerJson(req);
  const registro = await llm.salvarCredencial({
    provedor: texto(corpo.provedor, { campo: 'provedor', obrigatorio: true, max: 40 }),
    apelido: texto(corpo.apelido, { campo: 'apelido', max: 80 }),
    modelo: texto(corpo.modelo, { campo: 'modelo', obrigatorio: true, max: 120 }),
    baseUrl: texto(corpo.baseUrl, { campo: 'baseUrl', max: 300 }),
    apiKey: String(corpo.apiKey || ''),
  });
  db.registrarAuditoria({
    tipo: 'credencial_llm_criada',
    usuarioId: contexto.usuario.id,
    provedor: registro.provedor,
  });
  await db.salvar();
  json(res, 201, { credencial: registro });
}

async function excluirCredencial(req, res, contexto) {
  await llm.removerCredencial(contexto.parametros.id);
  db.registrarAuditoria({ tipo: 'credencial_llm_removida', usuarioId: contexto.usuario.id });
  await db.salvar();
  json(res, 200, { ok: true });
}

async function ativarCredencial(req, res, contexto) {
  await llm.definirAtiva(contexto.parametros.id);
  json(res, 200, { ok: true, credenciais: llm.listarCredenciais() });
}

async function testarCredencial(req, res, contexto) {
  const controle = limites.consumir(
    `teste:${contexto.usuario.id}`,
    limites.REGRAS.testeLlm.limite,
    limites.REGRAS.testeLlm.janelaMs
  );
  if (!controle.permitido) return erro(res, 429, 'Muitos testes seguidos. Aguarde alguns minutos.');

  try {
    const resultado = await llm.testarCredencial(contexto.parametros.id);
    json(res, 200, resultado);
  } catch (falha) {
    erro(res, 400, falha.message);
  }
}

async function salvarBuscaWeb(req, res, contexto) {
  const corpo = await lerJson(req);
  const provedor = texto(corpo.provedor, { campo: 'provedor', obrigatorio: true, max: 40 });
  if (!buscaWeb.PROVEDORES_BUSCA[provedor]) return erro(res, 400, 'Provedor de busca invalido.');

  const chave = String(corpo.apiKey || '').trim();
  if (chave.length < 8) return erro(res, 400, 'Informe uma chave de API valida.');

  const dados = db.estado();
  dados.configuracoes.integracoes.buscaWeb = {
    provedor,
    chaveCifrada: cifrar(chave, buscaWeb.CONTEXTO_CRIPTO),
    chaveMascarada: mascarar(chave),
    criadoEm: new Date().toISOString(),
  };
  db.registrarAuditoria({ tipo: 'busca_web_configurada', usuarioId: contexto.usuario.id, provedor });
  await db.salvar();
  json(res, 200, { ok: true, provedor, chaveMascarada: mascarar(chave) });
}

async function removerBuscaWeb(req, res) {
  const dados = db.estado();
  dados.configuracoes.integracoes.buscaWeb = null;
  await db.salvar();
  json(res, 200, { ok: true });
}

// ----------------------------------------------------------------- pesquisa

/**
 * Dispara a pesquisa e transmite o progresso por Server-Sent Events.
 * E o que o botao "Buscar leads" chama.
 */
async function pesquisar(req, res, contexto) {
  const controle = limites.consumir(
    `pesquisa:${contexto.usuario.id}`,
    limites.REGRAS.pesquisa.limite,
    limites.REGRAS.pesquisa.janelaMs
  );
  if (!controle.permitido) {
    return erro(res, 429, 'Limite de pesquisas por hora atingido. Tente novamente mais tarde.');
  }

  const ativas = execucoesAtivas.get(contexto.usuario.id) || new Set();
  if (ativas.size >= config.maxRunsConcorrentes) {
    return erro(res, 429, `Voce ja tem ${ativas.size} pesquisa(s) em andamento. Aguarde concluir.`);
  }

  const corpo = await lerJson(req);

  const tiers = Array.isArray(corpo.tiers)
    ? corpo.tiers.map(Number).filter((t) => [1, 2, 3, 4].includes(t))
    : [];
  if (!tiers.length) return erro(res, 400, 'Selecione ao menos um tier.');

  const regiao = texto(corpo.regiao, { campo: 'regiao', max: 120 });
  const segmentoLivre = texto(corpo.segmento, { campo: 'segmento', max: 400 });
  const profundidade = umDe(corpo.profundidade, ['rapida', 'padrao', 'profunda'], 'padrao');
  const credencialId = corpo.credencialId ? String(corpo.credencialId).slice(0, 60) : null;

  const controlador = new AbortController();
  ativas.add(controlador);
  execucoesAtivas.set(contexto.usuario.id, ativas);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const emitir = (evento, dados) => {
    if (res.writableEnded) return;
    res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  };

  // Se o cliente fechar a aba, aborta a execucao (para de gastar creditos).
  const aoFechar = () => controlador.abort();
  req.on('close', aoFechar);

  const batida = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 15000);

  try {
    await orquestrador.executarPesquisa({
      usuarioId: contexto.usuario.id,
      tiers,
      regiao,
      segmentoLivre,
      profundidade,
      credencialId,
      emitir,
      signal: controlador.signal,
    });
  } catch (falha) {
    emitir('erro', { mensagem: falha.message || 'Falha na pesquisa.' });
  } finally {
    clearInterval(batida);
    req.off('close', aoFechar);
    ativas.delete(controlador);
    if (!res.writableEnded) res.end();
  }
}

function listarExecucoes(req, res) {
  const dados = db.estado();
  const execucoes = dados.execucoes.slice(-30).reverse();
  json(res, 200, { execucoes });
}

module.exports = {
  leadNoEscopo,
  metadados,
  listarLeads,
  kanban,
  reatribuirLead,
  buscarDecisores,
  criarContato,
  removerContato,
  obterLead,
  atualizarLead,
  removerLead,
  exportarCsv,
  listarConfiguracoes,
  criarCredencial,
  excluirCredencial,
  ativarCredencial,
  testarCredencial,
  salvarBuscaWeb,
  removerBuscaWeb,
  pesquisar,
  listarExecucoes,
};
