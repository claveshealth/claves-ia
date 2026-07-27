'use strict';

const db = require('../store/db');
const llm = require('../llm');
const icp = require('../agentes/icp');
const orquestrador = require('../agentes/orquestrador');
const buscaWeb = require('../fontes/buscaWeb');
const limites = require('../security/limites');
const { cifrar, mascarar } = require('../security/crypto');
const { json, erro, lerJson, texto, umDe } = require('../lib/http');
const config = require('../config');

// Execucoes em andamento por usuario (para limitar concorrencia e cancelar).
const execucoesAtivas = new Map(); // usuarioId -> Set<AbortController>

// ---------------------------------------------------------------- metadados

function metadados(req, res) {
  json(res, 200, {
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

  let leads = dados.leads.slice();

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

  json(res, 200, {
    total: leads.length,
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
      criadoEm: l.criadoEm,
      atualizadoEm: l.atualizadoEm,
    })),
    resumo: {
      total: dados.leads.length,
      porTier: [1, 2, 3, 4].map((t) => ({
        tier: t,
        quantidade: dados.leads.filter((l) => l.tier === t && l.status !== 'descartado').length,
      })),
      descartados: dados.leads.filter((l) => l.status === 'descartado').length,
    },
  });
}

function obterLead(req, res, contexto) {
  const dados = db.estado();
  const lead = dados.leads.find((l) => l.id === contexto.parametros.id);
  if (!lead) return erro(res, 404, 'Lead nao encontrado.');
  const contatos = dados.contatos.filter((c) => c.leadId === lead.id);
  json(res, 200, { lead, contatos });
}

async function atualizarLead(req, res, contexto) {
  const dados = db.estado();
  const lead = dados.leads.find((l) => l.id === contexto.parametros.id);
  if (!lead) return erro(res, 404, 'Lead nao encontrado.');

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
  const dados = db.estado();
  const antes = dados.leads.length;
  dados.leads = dados.leads.filter((l) => l.id !== contexto.parametros.id);
  if (dados.leads.length === antes) return erro(res, 404, 'Lead nao encontrado.');
  dados.contatos = dados.contatos.filter((c) => c.leadId !== contexto.parametros.id);
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

function exportarCsv(req, res) {
  const dados = db.estado();
  const colunas = [
    'empresa', 'tier', 'score', 'status', 'confianca', 'cidade', 'uf', 'site',
    'segmento', 'vagas_estimadas', 'porque_claves', 'gancho', 'decisor_nome',
    'decisor_cargo', 'decisor_linkedin', 'decisor_fonte', 'decisor_status_atual',
  ];
  const linhas = [colunas.join(',')];

  for (const lead of dados.leads) {
    if (lead.status === 'descartado') continue;
    const contatos = dados.contatos.filter((c) => c.leadId === lead.id);
    const base = [
      lead.empresa?.nome, lead.tier, lead.score, lead.status, lead.confianca,
      lead.empresa?.cidade, lead.empresa?.uf, lead.empresa?.site,
      lead.empresa?.segmento, lead.volumeEstimadoVagas, lead.porqueClaves,
      lead.ganchoAbordagem,
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

// ------------------------------------------------------------ configuracoes

function listarConfiguracoes(req, res) {
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
  metadados,
  listarLeads,
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
