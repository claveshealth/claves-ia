'use strict';

/**
 * Adaptador Google Gemini (API Generative Language).
 * Sem busca web server-side no caminho usado aqui — o agente recorre as
 * ferramentas `buscar_web` / `ler_pagina` da propria aplicacao.
 */

const { fetchSeguro } = require('../security/ssrf');

const MODELOS_SUGERIDOS = [
  { id: 'gemini-2.5-pro', rotulo: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash', rotulo: 'gemini-2.5-flash' },
];

function baseNormalizada(baseUrl) {
  return String(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
}

function paraConteudosApi(mensagens) {
  return mensagens.map((m) => {
    const partes = [];
    for (const b of m.blocos) {
      if (b.tipo === 'texto') {
        partes.push({ text: b.texto });
      } else if (b.tipo === 'ferramenta') {
        partes.push({ functionCall: { name: b.nome, args: b.entrada ?? {} } });
      } else if (b.tipo === 'resultado') {
        let conteudo = b.conteudo;
        if (typeof conteudo === 'string') {
          try {
            conteudo = JSON.parse(conteudo);
          } catch {
            conteudo = { resultado: conteudo };
          }
        }
        partes.push({
          functionResponse: { name: b.nomeFerramenta || 'ferramenta', response: conteudo },
        });
      }
    }
    return { role: m.papel === 'assistant' ? 'model' : 'user', parts: partes };
  });
}

function paraBlocosNormalizados(candidato) {
  const blocos = [];
  let contador = 0;
  for (const parte of candidato?.content?.parts || []) {
    if (parte.text) {
      blocos.push({ tipo: 'texto', texto: parte.text });
    } else if (parte.functionCall) {
      contador += 1;
      blocos.push({
        tipo: 'ferramenta',
        // Gemini nao devolve id de chamada: geramos um estavel para o loop.
        id: `gemini_call_${Date.now()}_${contador}`,
        nome: parte.functionCall.name,
        entrada: parte.functionCall.args || {},
      });
    }
  }
  return blocos;
}

async function chamar({ apiKey, baseUrl, modelo, corpo, signal, timeoutMs = 10 * 60 * 1000 }) {
  const url = `${baseNormalizada(baseUrl)}/models/${encodeURIComponent(modelo)}:generateContent`;
  const resposta = await fetchSeguro(url, {
    metodo: 'POST',
    cabecalhos: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey, // no header, nunca na query string (evita log de URL)
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
    throw new Error(`Resposta nao-JSON do Gemini (HTTP ${resposta.status}): ${texto.slice(0, 200)}`);
  }
  if (!resposta.ok) {
    throw new Error(`Gemini retornou erro: ${dados?.error?.message || `HTTP ${resposta.status}`}`);
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
    contents: paraConteudosApi(mensagens),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (sistema) corpo.systemInstruction = { parts: [{ text: sistema }] };
  if (ferramentas.length) {
    corpo.tools = [
      {
        functionDeclarations: ferramentas.map((f) => ({
          name: f.nome,
          description: f.descricao,
          parameters: f.esquema,
        })),
      },
    ];
  }

  const dados = await chamar({ apiKey, baseUrl, modelo, corpo, signal });
  const candidato = dados.candidates?.[0];
  if (!candidato) {
    const bloqueio = dados.promptFeedback?.blockReason;
    throw new Error(bloqueio ? `Gemini bloqueou o prompt: ${bloqueio}` : 'Gemini nao retornou candidatos.');
  }

  const blocos = paraBlocosNormalizados(candidato);
  const temFerramenta = blocos.some((b) => b.tipo === 'ferramenta');

  return {
    blocos,
    paradaPor: temFerramenta ? 'tool_use' : candidato.finishReason || 'end_turn',
    detalhesParada: null,
    uso: {
      entrada: dados.usageMetadata?.promptTokenCount ?? 0,
      saida: dados.usageMetadata?.candidatesTokenCount ?? 0,
      cacheLeitura: dados.usageMetadata?.cachedContentTokenCount ?? 0,
    },
  };
}

async function testar({ apiKey, baseUrl, modelo }) {
  const dados = await chamar({
    apiKey,
    baseUrl,
    modelo,
    timeoutMs: 60000,
    corpo: {
      contents: [{ role: 'user', parts: [{ text: 'Responda apenas: OK' }] }],
      generationConfig: { maxOutputTokens: 32 },
    },
  });
  const texto = dados.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return { ok: true, modelo, amostra: texto.trim().slice(0, 60) };
}

module.exports = {
  id: 'google',
  nome: 'Google Gemini',
  suportaBuscaWebNativa: false,
  precisaBaseUrl: false,
  baseUrlPadrao: 'https://generativelanguage.googleapis.com/v1beta',
  modelosSugeridos: MODELOS_SUGERIDOS,
  conversar,
  testar,
};
