'use strict';

/**
 * Adaptador para qualquer API compativel com o formato OpenAI
 * /chat/completions — OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral,
 * Azure OpenAI, vLLM local exposto publicamente etc.
 *
 * E este adaptador que atende o requisito de "campo para inserir qualquer API
 * de LLM": basta informar a base URL e o nome do modelo.
 *
 * Estes provedores nao tem busca web server-side no formato padrao, entao o
 * agente usa as ferramentas `buscar_web` / `ler_pagina` implementadas pela
 * propria aplicacao (exigem uma chave de busca em Configuracoes).
 */

const { fetchSeguro } = require('../security/ssrf');

const MODELOS_SUGERIDOS = [
  { id: 'gpt-5', rotulo: 'gpt-5' },
  { id: 'gpt-5-mini', rotulo: 'gpt-5-mini' },
  { id: 'deepseek-chat', rotulo: 'deepseek-chat (DeepSeek)' },
  { id: 'llama-3.3-70b-versatile', rotulo: 'llama-3.3-70b-versatile (Groq)' },
];

function baseNormalizada(baseUrl) {
  return String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/** Normalizado -> formato OpenAI (papeis planos + tool_calls). */
function paraMensagensApi(sistema, mensagens) {
  const saida = [];
  if (sistema) saida.push({ role: 'system', content: sistema });

  for (const m of mensagens) {
    if (m.papel === 'assistant') {
      const textos = m.blocos.filter((b) => b.tipo === 'texto').map((b) => b.texto);
      const chamadas = m.blocos
        .filter((b) => b.tipo === 'ferramenta')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.nome, arguments: JSON.stringify(b.entrada ?? {}) },
        }));
      const mensagem = { role: 'assistant', content: textos.join('\n') || null };
      if (chamadas.length) mensagem.tool_calls = chamadas;
      saida.push(mensagem);
      continue;
    }

    // Papel "user": pode conter texto e/ou resultados de ferramenta. No
    // formato OpenAI cada resultado vira uma mensagem role:"tool" separada.
    const resultados = m.blocos.filter((b) => b.tipo === 'resultado');
    for (const r of resultados) {
      saida.push({
        role: 'tool',
        tool_call_id: r.idFerramenta,
        content: typeof r.conteudo === 'string' ? r.conteudo : JSON.stringify(r.conteudo),
      });
    }
    const textos = m.blocos.filter((b) => b.tipo === 'texto').map((b) => b.texto);
    if (textos.length) saida.push({ role: 'user', content: textos.join('\n') });
  }
  return saida;
}

function paraBlocosNormalizados(mensagem) {
  const blocos = [];
  if (mensagem.content) blocos.push({ tipo: 'texto', texto: String(mensagem.content) });
  for (const chamada of mensagem.tool_calls || []) {
    let entrada = {};
    try {
      entrada = JSON.parse(chamada.function?.arguments || '{}');
    } catch {
      entrada = { _argumentosInvalidos: chamada.function?.arguments || '' };
    }
    blocos.push({ tipo: 'ferramenta', id: chamada.id, nome: chamada.function?.name, entrada });
  }
  return blocos;
}

async function chamar({ apiKey, baseUrl, corpo, signal, timeoutMs = 10 * 60 * 1000 }) {
  const resposta = await fetchSeguro(`${baseNormalizada(baseUrl)}/chat/completions`, {
    metodo: 'POST',
    cabecalhos: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    corpo: JSON.stringify(corpo),
    timeoutMs,
    maxBytes: 8 * 1024 * 1024,
    signal,
  });

  const texto = resposta.texto();
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new Error(`Resposta nao-JSON do provedor (HTTP ${resposta.status}): ${texto.slice(0, 200)}`);
  }
  if (!resposta.ok) {
    const mensagem = dados?.error?.message || `HTTP ${resposta.status}`;
    throw new Error(`Provedor retornou erro: ${mensagem}`);
  }
  return dados;
}

async function conversar({
  apiKey,
  baseUrl,
  modelo,
  sistema,
  mensagens,
  ferramentas = [],
  maxTokens,
  signal,
}) {
  const corpo = {
    model: modelo,
    max_completion_tokens: maxTokens,
    messages: paraMensagensApi(sistema, mensagens),
  };
  if (ferramentas.length) {
    corpo.tools = ferramentas.map((f) => ({
      type: 'function',
      function: { name: f.nome, description: f.descricao, parameters: f.esquema },
    }));
    corpo.tool_choice = 'auto';
  }

  const dados = await chamar({ apiKey, baseUrl, corpo, signal });
  const escolha = dados.choices?.[0];
  if (!escolha) throw new Error('Provedor nao retornou nenhuma escolha (choices vazio).');

  return {
    blocos: paraBlocosNormalizados(escolha.message || {}),
    paradaPor: escolha.finish_reason === 'tool_calls' ? 'tool_use' : escolha.finish_reason,
    detalhesParada: null,
    uso: {
      entrada: dados.usage?.prompt_tokens ?? 0,
      saida: dados.usage?.completion_tokens ?? 0,
      cacheLeitura: 0,
    },
  };
}

async function testar({ apiKey, baseUrl, modelo }) {
  const dados = await chamar({
    apiKey,
    baseUrl,
    timeoutMs: 60000,
    corpo: {
      model: modelo,
      max_completion_tokens: 32,
      messages: [{ role: 'user', content: 'Responda apenas: OK' }],
    },
  });
  return {
    ok: true,
    modelo: dados.model || modelo,
    amostra: String(dados.choices?.[0]?.message?.content || '').trim().slice(0, 60),
  };
}

module.exports = {
  id: 'openai',
  nome: 'OpenAI / compativel (OpenRouter, Groq, DeepSeek, Azure, local...)',
  suportaBuscaWebNativa: false,
  precisaBaseUrl: false,
  baseUrlPadrao: 'https://api.openai.com/v1',
  modelosSugeridos: MODELOS_SUGERIDOS,
  conversar,
  testar,
};
