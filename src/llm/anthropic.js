'use strict';

/**
 * Adaptador Anthropic — o provedor recomendado.
 *
 * E o unico dos tres que traz busca e leitura de web nativas do lado do
 * servidor (web_search_20260209 / web_fetch_20260209), o que significa
 * pesquisa real na internet sem depender de nenhuma API de busca adicional.
 * Por isso a pesquisa profunda de leads roda melhor aqui.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { validarUrlExterna } = require('../security/ssrf');

const MODELOS_SUGERIDOS = [
  { id: 'claude-opus-5', rotulo: 'Claude Opus 5 (recomendado — pesquisa profunda)' },
  { id: 'claude-sonnet-5', rotulo: 'Claude Sonnet 5 (mais barato e rapido)' },
  { id: 'claude-opus-4-8', rotulo: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5', rotulo: 'Claude Haiku 4.5 (tarefas simples)' },
];

// Modelos que suportam a versao das server tools com filtragem dinamica.
const SUPORTA_TOOLS_NOVAS = /^claude-(opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;

function versoesFerramentasWeb(modelo) {
  return SUPORTA_TOOLS_NOVAS.test(String(modelo))
    ? { busca: 'web_search_20260209', leitura: 'web_fetch_20260209' }
    : { busca: 'web_search_20250305', leitura: null };
}

async function criarCliente({ apiKey, baseUrl, signal }) {
  const opcoes = {
    apiKey,
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  };
  if (baseUrl) {
    await validarUrlExterna(baseUrl); // baseUrl vem do usuario: valida SSRF
    opcoes.baseURL = baseUrl;
  }
  return new Anthropic(opcoes);
}

/** Converte as ferramentas normalizadas para o formato da API. */
function montarFerramentas(ferramentas, modelo, { buscaWebNativa }) {
  const lista = ferramentas.map((f) => ({
    name: f.nome,
    description: f.descricao,
    input_schema: f.esquema,
  }));

  if (buscaWebNativa) {
    const versoes = versoesFerramentasWeb(modelo);
    lista.unshift({ type: versoes.busca, name: 'web_search', max_uses: 30 });
    if (versoes.leitura) {
      lista.unshift({ type: versoes.leitura, name: 'web_fetch', max_uses: 30, max_content_tokens: 20000 });
    }
  }
  return lista;
}

/** Normalizado -> Anthropic. Blocos `bruto` sao reenviados sem alteracao. */
function paraMensagensApi(mensagens) {
  return mensagens.map((m) => ({
    role: m.papel,
    content: m.blocos.map((b) => {
      switch (b.tipo) {
        case 'texto':
          return { type: 'text', text: b.texto };
        case 'ferramenta':
          return { type: 'tool_use', id: b.id, name: b.nome, input: b.entrada };
        case 'resultado':
          return {
            type: 'tool_result',
            tool_use_id: b.idFerramenta,
            content: b.conteudo,
            ...(b.erro ? { is_error: true } : {}),
          };
        case 'bruto':
          return b.dados;
        default:
          return { type: 'text', text: String(b.texto ?? '') };
      }
    }),
  }));
}

/** Anthropic -> normalizado. Preserva thinking e resultados de server tools. */
function paraBlocosNormalizados(conteudo) {
  return conteudo.map((b) => {
    if (b.type === 'text') return { tipo: 'texto', texto: b.text };
    if (b.type === 'tool_use') return { tipo: 'ferramenta', id: b.id, nome: b.name, entrada: b.input };
    // thinking, server_tool_use, web_search_tool_result, web_fetch_tool_result...
    return { tipo: 'bruto', dados: b };
  });
}

async function conversar({
  apiKey,
  baseUrl,
  modelo,
  sistema,
  mensagens,
  ferramentas = [],
  maxTokens,
  esforco = 'high',
  buscaWebNativa = true,
  signal,
}) {
  const cliente = await criarCliente({ apiKey, baseUrl, signal });

  const parametros = {
    model: modelo,
    max_tokens: maxTokens,
    system: sistema,
    messages: paraMensagensApi(mensagens),
    thinking: { type: 'adaptive' },
    output_config: { effort: esforco },
  };

  const listaFerramentas = montarFerramentas(ferramentas, modelo, { buscaWebNativa });
  if (listaFerramentas.length) parametros.tools = listaFerramentas;

  // Sempre streaming: max_tokens alto em requisicao unica estoura o timeout
  // HTTP do SDK. finalMessage() devolve a mensagem completa.
  const fluxo = cliente.messages.stream(parametros, { signal });
  const resposta = await fluxo.finalMessage();

  return {
    blocos: paraBlocosNormalizados(resposta.content),
    paradaPor: resposta.stop_reason,
    detalhesParada: resposta.stop_details || null,
    uso: {
      entrada: resposta.usage?.input_tokens ?? 0,
      saida: resposta.usage?.output_tokens ?? 0,
      cacheLeitura: resposta.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

async function testar({ apiKey, baseUrl, modelo }) {
  const cliente = await criarCliente({ apiKey, baseUrl });
  const resposta = await cliente.messages.create({
    model: modelo,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Responda apenas: OK' }],
  });
  const texto = resposta.content.find((b) => b.type === 'text')?.text || '';
  return { ok: true, modelo: resposta.model, amostra: texto.trim().slice(0, 60) };
}

module.exports = {
  id: 'anthropic',
  nome: 'Anthropic (Claude)',
  suportaBuscaWebNativa: true,
  precisaBaseUrl: false,
  modelosSugeridos: MODELOS_SUGERIDOS,
  conversar,
  testar,
};
