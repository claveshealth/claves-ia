'use strict';

/**
 * Orquestrador da pesquisa de leads.
 *
 * Pipeline em duas fases, cada uma com seu proprio loop agentico:
 *
 *   FASE 1 — DESCOBERTA
 *     Varre a web procurando empresas privadas com a dor do ICP. Sai com uma
 *     lista de candidatas (barata, ampla, superficial).
 *
 *   FASE 2 — APROFUNDAMENTO (uma execucao isolada por empresa)
 *     Investiga cada candidata a fundo: confirma o tier, comprova sinais de
 *     compra com fonte e data, mede o volume de vagas e — o ponto central —
 *     encontra os tomadores de decisao com nome completo e cargo atuais.
 *
 * Contexto isolado por empresa e deliberado: mantem o modelo focado e evita
 * que evidencia de uma empresa contamine o dossie de outra.
 */

const llm = require('../llm');
const prompts = require('./prompts');
const ferramentas = require('./ferramentas');
const buscaWeb = require('../fontes/buscaWeb');
const db = require('../store/db');
const { id: novoId } = require('../security/crypto');
const icp = require('./icp');

const PERFIS_PROFUNDIDADE = {
  rapida: { esforco: 'medium', maxIteracoes: 12, candidatas: 6, aprofundar: 3, maxTokens: 16000 },
  padrao: { esforco: 'high', maxIteracoes: 22, candidatas: 12, aprofundar: 6, maxTokens: 16000 },
  profunda: { esforco: 'xhigh', maxIteracoes: 36, candidatas: 18, aprofundar: 10, maxTokens: 32000 },
};

/**
 * Loop agentico generico: conversa com o modelo ate ele parar de pedir
 * ferramentas. Executa as ferramentas locais e devolve os resultados.
 */
async function rodarAgente({
  credencial,
  sistema,
  tarefa,
  listaFerramentas,
  contexto,
  maxIteracoes,
  esforco,
  maxTokens,
  usarWebNativa,
  rotulo,
}) {
  const porNome = new Map(listaFerramentas.map((f) => [f.nome, f]));
  const mensagens = [{ papel: 'user', blocos: [{ tipo: 'texto', texto: tarefa }] }];
  const uso = { entrada: 0, saida: 0, chamadas: 0 };
  let textoFinal = '';

  for (let iteracao = 1; iteracao <= maxIteracoes; iteracao += 1) {
    if (contexto.signal?.aborted) throw new Error('Pesquisa cancelada.');

    contexto.emitir('progresso', { fase: rotulo, iteracao, maxIteracoes });

    const resposta = await credencial.adaptador.conversar({
      apiKey: credencial.apiKey,
      baseUrl: credencial.baseUrl,
      modelo: credencial.modelo,
      sistema,
      mensagens,
      ferramentas: listaFerramentas.map((f) => ({
        nome: f.nome,
        descricao: f.descricao,
        esquema: f.esquema,
      })),
      maxTokens,
      esforco,
      buscaWebNativa: usarWebNativa,
      signal: contexto.signal,
    });

    uso.entrada += resposta.uso.entrada;
    uso.saida += resposta.uso.saida;

    mensagens.push({ papel: 'assistant', blocos: resposta.blocos });

    const textos = resposta.blocos.filter((b) => b.tipo === 'texto').map((b) => b.texto);
    if (textos.length) {
      textoFinal = textos.join('\n');
      contexto.emitir('pensamento', { fase: rotulo, texto: textoFinal.slice(0, 600) });
    }

    if (resposta.paradaPor === 'refusal') {
      throw new Error(
        `O provedor recusou a solicitacao${resposta.detalhesParada?.category ? ` (categoria: ${resposta.detalhesParada.category})` : ''}.`
      );
    }

    // Ferramentas server-side (Anthropic) atingiram o limite de rodadas:
    // basta reenviar a conversa para o servidor retomar de onde parou.
    if (resposta.paradaPor === 'pause_turn') continue;

    const chamadas = resposta.blocos.filter((b) => b.tipo === 'ferramenta');
    if (!chamadas.length) break; // end_turn / max_tokens: o agente concluiu

    const resultados = [];
    for (const chamada of chamadas) {
      uso.chamadas += 1;
      const ferramenta = porNome.get(chamada.nome);

      if (!ferramenta) {
        resultados.push({
          tipo: 'resultado',
          idFerramenta: chamada.id,
          nomeFerramenta: chamada.nome,
          conteudo: `Ferramenta desconhecida: ${chamada.nome}`,
          erro: true,
        });
        continue;
      }

      contexto.emitir('ferramenta', {
        fase: rotulo,
        nome: chamada.nome,
        entrada: resumirEntrada(chamada.nome, chamada.entrada),
      });

      try {
        const saida = await ferramenta.executar(chamada.entrada || {}, contexto);
        resultados.push({
          tipo: 'resultado',
          idFerramenta: chamada.id,
          nomeFerramenta: chamada.nome,
          conteudo: JSON.stringify(saida).slice(0, 60000),
          erro: false,
        });
      } catch (erro) {
        // Erro de ferramenta volta como resultado, nao derruba a execucao:
        // o agente pode tentar outro caminho.
        resultados.push({
          tipo: 'resultado',
          idFerramenta: chamada.id,
          nomeFerramenta: chamada.nome,
          conteudo: `Erro ao executar: ${erro.message}`,
          erro: true,
        });
        contexto.emitir('aviso', { fase: rotulo, mensagem: `${chamada.nome}: ${erro.message}` });
      }
    }

    mensagens.push({ papel: 'user', blocos: resultados });
  }

  return { textoFinal, uso };
}

function resumirEntrada(nome, entrada) {
  if (!entrada) return '';
  if (nome === 'buscar_web') return String(entrada.consulta || '').slice(0, 160);
  if (nome === 'ler_pagina') return String(entrada.url || '').slice(0, 160);
  if (nome === 'buscar_linkedin') {
    return `LinkedIn: ${String(entrada.empresa || '').slice(0, 90)}`;
  }
  if (entrada.nome) return String(entrada.nome).slice(0, 160);
  return '';
}

function normalizarNome(nome) {
  return String(nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(ltda|s\.?a\.?|eireli|me|epp|grupo|instituto|associacao)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Defesa em profundidade: o modelo pode devolver uma "URL" que na verdade e
 * um esquema perigoso (javascript:, data:, file:). O front-end ja recusa
 * renderizar isso como link, mas nao guardamos lixo no banco.
 */
function urlPublicaOuNulo(bruta) {
  if (!bruta) return null;
  try {
    const url = new URL(String(bruta));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function saneaListaComUrl(lista, campo) {
  if (!Array.isArray(lista)) return [];
  return lista.map((item) => ({ ...item, [campo]: urlPublicaOuNulo(item?.[campo]) }));
}

function dominioDe(site) {
  try {
    return new URL(String(site).startsWith('http') ? site : `https://${site}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return null;
  }
}

/** Converte o dossie do agente em lead + contatos e grava no banco. */
function persistirDossie(dossie, { execucaoId, usuarioId }) {
  const dados = db.estado();
  const empresa = dossie.empresa || {};
  const chaveNome = normalizarNome(empresa.nome);
  const dominio = dominioDe(empresa.site);

  const existente = dados.leads.find((l) => {
    if (dominio && l.empresa.dominio && l.empresa.dominio === dominio) return true;
    return chaveNome && normalizarNome(l.empresa.nome) === chaveNome;
  });

  const agora = new Date().toISOString();
  const antiPersonaAtingida = !!dossie.antiPersona?.atingido;

  const corpo = {
    empresa: {
      nome: empresa.nome,
      nomeFantasia: empresa.nomeFantasia || null,
      cnpj: empresa.cnpj || null,
      site: urlPublicaOuNulo(empresa.site),
      dominio,
      cidade: empresa.cidade || null,
      uf: empresa.uf || null,
      abrangencia: empresa.abrangencia || 'desconhecida',
      porteEstimado: empresa.porteEstimado || 'desconhecido',
      segmento: empresa.segmento || null,
      linkedinEmpresa: urlPublicaOuNulo(empresa.linkedinEmpresa),
    },
    tier: Number(dossie.tier) || null,
    justificativaTier: dossie.justificativaTier || null,
    porqueClaves: dossie.porqueClaves || null,
    dorIdentificada: dossie.dorIdentificada || null,
    sinaisDeCompra: saneaListaComUrl(dossie.sinaisDeCompra, 'fonteUrl'),
    vagasAbertas: saneaListaComUrl(dossie.vagasAbertas, 'fonteUrl'),
    volumeEstimadoVagas: Number(dossie.volumeEstimadoVagas) || 0,
    antiPersona: {
      atingido: antiPersonaAtingida,
      codigos: dossie.antiPersona?.codigos || [],
      justificativa: dossie.antiPersona?.justificativa || null,
    },
    score: Math.max(0, Math.min(100, Number(dossie.score) || 0)),
    confianca: dossie.confianca || 'baixa',
    ganchoAbordagem: dossie.ganchoAbordagem || null,
    proximoPasso: dossie.proximoPasso || null,
    fontes: saneaListaComUrl(dossie.fontes, 'url').filter((f) => f.url),
    observacoes: dossie.observacoes || null,
    atualizadoEm: agora,
    execucaoId,
  };

  let lead;
  if (existente) {
    Object.assign(existente, corpo);
    lead = existente;
    // Remove contatos anteriores desta empresa para regravar a versao atual.
    dados.contatos = dados.contatos.filter((c) => c.leadId !== lead.id);
  } else {
    lead = {
      id: novoId('lead'),
      criadoEm: agora,
      status: antiPersonaAtingida ? 'descartado' : 'novo',
      dono: usuarioId,
      notas: [],
      ...corpo,
    };
    dados.leads.push(lead);
  }

  const decisores = Array.isArray(dossie.decisores) ? dossie.decisores : [];
  const contatosGravados = [];
  for (const decisor of decisores) {
    // Quem ja saiu da empresa nao entra: o pedido e por dados ATUAIS.
    if (decisor.statusAtual === 'saiu_da_empresa') continue;
    if (!decisor.nomeCompleto || !decisor.cargo) continue;

    const contato = {
      id: novoId('ctt'),
      leadId: lead.id,
      nomeCompleto: String(decisor.nomeCompleto).slice(0, 200),
      cargo: String(decisor.cargo).slice(0, 200),
      area: decisor.area || 'outro',
      senioridade: decisor.senioridade || 'outro',
      linkedinUrl: urlPublicaOuNulo(decisor.linkedinUrl),
      emailPublico: decisor.emailPublico || null,
      telefonePublico: decisor.telefonePublico || null,
      fonteUrl: urlPublicaOuNulo(decisor.fonteUrl),
      fonteTitulo: decisor.fonteTitulo || null,
      dataDaEvidencia: decisor.dataDaEvidencia || null,
      statusAtual: decisor.statusAtual || 'nao_confirmado',
      trechoEvidencia: decisor.trechoEvidencia ? String(decisor.trechoEvidencia).slice(0, 400) : null,
      confianca: decisor.confianca || 'baixa',
      criadoEm: agora,
      execucaoId,
    };
    dados.contatos.push(contato);
    contatosGravados.push(contato);
  }

  return { lead, contatos: contatosGravados, novo: !existente };
}

/**
 * Executa a pesquisa completa.
 * `emitir(evento, dados)` recebe o progresso em tempo real (vira SSE na rota).
 */
async function executarPesquisa({
  usuarioId,
  tiers,
  regiao,
  segmentoLivre,
  profundidade = 'padrao',
  credencialId = null,
  emitir = () => {},
  signal,
}) {
  const perfil = PERFIS_PROFUNDIDADE[profundidade] || PERFIS_PROFUNDIDADE.padrao;
  const credencial = llm.resolverCredencial(credencialId);
  const usarWebNativa = credencial.adaptador.suportaBuscaWebNativa;

  // Provedor sem busca nativa precisa de uma API de busca cadastrada; sem ela
  // o agente ficaria cego e produziria dossies inventados.
  if (!usarWebNativa && !buscaWeb.buscaDisponivel()) {
    const erro = new Error(
      `O provedor "${credencial.adaptador.nome}" nao tem busca web nativa. Cadastre uma chave de busca (Brave, Serper ou Tavily) em Configuracoes -> Integracoes, ou selecione uma credencial Anthropic.`
    );
    erro.status = 428;
    throw erro;
  }

  const execucaoId = novoId('run');
  const iniciadoEm = new Date().toISOString();

  const contexto = {
    signal,
    emitir,
    candidatas: [],
    descartes: [],
    dossies: [],
  };

  const usoTotal = { entrada: 0, saida: 0, chamadas: 0 };

  emitir('inicio', {
    execucaoId,
    provedor: credencial.adaptador.nome,
    modelo: credencial.modelo,
    buscaWeb: usarWebNativa ? 'nativa do provedor' : 'API de busca configurada',
    profundidade,
    tiers,
    regiao: regiao || 'Brasil',
  });

  // ---------------------------------------------------------------- FASE 1
  emitir('fase', { nome: 'descoberta', descricao: 'Varrendo a web em busca de empresas privadas com a dor do ICP' });

  const ferramentasDescoberta = ferramentas.montar({
    fase: 'descoberta',
    incluirWeb: !usarWebNativa,
  });

  const descoberta = await rodarAgente({
    credencial,
    sistema: prompts.sistemaDescoberta(),
    tarefa: prompts.tarefaDescoberta({
      tiers,
      regiao,
      segmentoLivre,
      quantidadeAlvo: perfil.candidatas,
    }),
    listaFerramentas: ferramentasDescoberta,
    contexto,
    maxIteracoes: perfil.maxIteracoes,
    esforco: perfil.esforco,
    maxTokens: perfil.maxTokens,
    usarWebNativa,
    rotulo: 'descoberta',
  });

  usoTotal.entrada += descoberta.uso.entrada;
  usoTotal.saida += descoberta.uso.saida;
  usoTotal.chamadas += descoberta.uso.chamadas;

  const candidatas = contexto.candidatas.slice(0, perfil.aprofundar);
  emitir('descobertaConcluida', {
    candidatas: contexto.candidatas.length,
    descartes: contexto.descartes.length,
    aprofundar: candidatas.length,
    resumo: descoberta.textoFinal.slice(0, 1200),
  });

  // ---------------------------------------------------------------- FASE 2
  const resultados = [];

  for (const [indice, candidata] of candidatas.entries()) {
    if (signal?.aborted) break;

    emitir('fase', {
      nome: 'aprofundamento',
      descricao: `Investigando ${candidata.nome}`,
      indice: indice + 1,
      total: candidatas.length,
    });

    // Contexto proprio por empresa: dossies isolados, sem contaminacao cruzada.
    const contextoEmpresa = {
      signal,
      emitir,
      candidatas: [],
      descartes: contexto.descartes,
      dossies: [],
    };

    const ferramentasAprofundamento = ferramentas.montar({
      fase: 'aprofundamento',
      incluirWeb: !usarWebNativa,
    });

    try {
      const rodada = await rodarAgente({
        credencial,
        sistema: prompts.sistemaAprofundamento(),
        tarefa: prompts.tarefaAprofundamento(candidata, { regiao }),
        listaFerramentas: ferramentasAprofundamento,
        contexto: contextoEmpresa,
        maxIteracoes: perfil.maxIteracoes,
        esforco: perfil.esforco,
        maxTokens: perfil.maxTokens,
        usarWebNativa,
        rotulo: 'aprofundamento',
      });

      usoTotal.entrada += rodada.uso.entrada;
      usoTotal.saida += rodada.uso.saida;
      usoTotal.chamadas += rodada.uso.chamadas;

      for (const dossie of contextoEmpresa.dossies) {
        const gravado = persistirDossie(dossie, { execucaoId, usuarioId });
        resultados.push({
          leadId: gravado.lead.id,
          empresa: gravado.lead.empresa.nome,
          tier: gravado.lead.tier,
          score: gravado.lead.score,
          decisores: gravado.contatos.length,
          novo: gravado.novo,
          antiPersona: gravado.lead.antiPersona.atingido,
        });
        emitir('leadGravado', resultados[resultados.length - 1]);
      }
      await db.salvar();
    } catch (erro) {
      if (signal?.aborted) break;
      emitir('aviso', {
        fase: 'aprofundamento',
        mensagem: `Falha ao investigar ${candidata.nome}: ${erro.message}`,
      });
    }
  }

  // ------------------------------------------------------------- CONCLUSAO
  const concluidoEm = new Date().toISOString();
  const dados = db.estado();
  dados.execucoes.push({
    id: execucaoId,
    usuarioId,
    iniciadoEm,
    concluidoEm,
    parametros: { tiers, regiao: regiao || null, segmentoLivre: segmentoLivre || null, profundidade },
    provedor: credencial.adaptador.id,
    modelo: credencial.modelo,
    candidatasEncontradas: contexto.candidatas.length,
    descartes: contexto.descartes,
    leadsGravados: resultados.length,
    uso: usoTotal,
  });
  if (dados.execucoes.length > 200) dados.execucoes.splice(0, dados.execucoes.length - 200);
  await db.salvar();

  const resumo = {
    execucaoId,
    candidatasEncontradas: contexto.candidatas.length,
    aprofundadas: candidatas.length,
    leadsGravados: resultados.length,
    descartados: contexto.descartes.length,
    leads: resultados,
    uso: usoTotal,
  };

  emitir('fim', resumo);
  return resumo;
}

module.exports = { executarPesquisa, PERFIS_PROFUNDIDADE, TIERS: icp.TIERS };
