'use strict';

/**
 * Busca e leitura de paginas na web para provedores de LLM que NAO tem
 * ferramentas de web nativas (OpenAI-compativel, Gemini).
 *
 * Com Anthropic isso nao e usado: la a busca roda server-side no proprio
 * provedor. Aqui aceitamos Brave, Serper ou Tavily — o usuario cadastra a
 * chave em Configuracoes -> Integracoes.
 *
 * Toda requisicao de saida passa por fetchSeguro (validacao anti-SSRF,
 * timeout e teto de tamanho).
 */

const { fetchSeguro } = require('../security/ssrf');
const { decifrar } = require('../security/crypto');
const db = require('../store/db');

const CONTEXTO_CRIPTO = 'integracao:buscaWeb';

const PROVEDORES_BUSCA = {
  brave: {
    nome: 'Brave Search API',
    async buscar({ chave, consulta, quantidade, signal }) {
      const params = new URLSearchParams({
        q: consulta,
        count: String(Math.min(quantidade, 20)),
        country: 'br',
        search_lang: 'pt',
      });
      const resposta = await fetchSeguro(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          cabecalhos: { Accept: 'application/json', 'X-Subscription-Token': chave },
          timeoutMs: 25000,
          signal,
        }
      );
      if (!resposta.ok) throw new Error(`Brave HTTP ${resposta.status}`);
      const dados = JSON.parse(resposta.texto());
      return (dados.web?.results || []).map((r) => ({
        titulo: r.title,
        url: r.url,
        trecho: r.description,
        publicadoEm: r.page_age || null,
      }));
    },
  },
  serper: {
    nome: 'Serper.dev (Google)',
    async buscar({ chave, consulta, quantidade, signal }) {
      const resposta = await fetchSeguro('https://google.serper.dev/search', {
        metodo: 'POST',
        cabecalhos: { 'Content-Type': 'application/json', 'X-API-KEY': chave },
        corpo: JSON.stringify({ q: consulta, gl: 'br', hl: 'pt-br', num: Math.min(quantidade, 20) }),
        timeoutMs: 25000,
        signal,
      });
      if (!resposta.ok) throw new Error(`Serper HTTP ${resposta.status}`);
      const dados = JSON.parse(resposta.texto());
      return (dados.organic || []).map((r) => ({
        titulo: r.title,
        url: r.link,
        trecho: r.snippet,
        publicadoEm: r.date || null,
      }));
    },
  },
  tavily: {
    nome: 'Tavily',
    async buscar({ chave, consulta, quantidade, signal }) {
      const resposta = await fetchSeguro('https://api.tavily.com/search', {
        metodo: 'POST',
        cabecalhos: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` },
        corpo: JSON.stringify({
          query: consulta,
          max_results: Math.min(quantidade, 20),
          search_depth: 'advanced',
        }),
        timeoutMs: 30000,
        signal,
      });
      if (!resposta.ok) throw new Error(`Tavily HTTP ${resposta.status}`);
      const dados = JSON.parse(resposta.texto());
      return (dados.results || []).map((r) => ({
        titulo: r.title,
        url: r.url,
        trecho: r.content,
        publicadoEm: r.published_date || null,
      }));
    },
  },
};

function credencialBusca() {
  const integracao = db.estado().configuracoes.integracoes?.buscaWeb;
  if (!integracao?.chaveCifrada) return null;
  try {
    return {
      provedor: integracao.provedor,
      chave: decifrar(integracao.chaveCifrada, CONTEXTO_CRIPTO),
    };
  } catch {
    return null;
  }
}

function buscaDisponivel() {
  return credencialBusca() !== null;
}

async function buscar({ consulta, quantidade = 10, signal }) {
  const credencial = credencialBusca();
  if (!credencial) {
    throw new Error(
      'Nenhuma API de busca configurada. Cadastre uma chave (Brave, Serper ou Tavily) em Configuracoes -> Integracoes, ou use o provedor Anthropic, que tem busca web nativa.'
    );
  }
  const provedor = PROVEDORES_BUSCA[credencial.provedor];
  if (!provedor) throw new Error(`Provedor de busca desconhecido: ${credencial.provedor}`);

  const resultados = await provedor.buscar({
    chave: credencial.chave,
    consulta,
    quantidade,
    signal,
  });
  return { consulta, provedor: provedor.nome, total: resultados.length, resultados };
}

/**
 * Extracao de texto legivel de HTML. Deliberadamente sem dependencia de
 * parser: remove script/style/nav, converte tags em quebras e normaliza.
 * Basta para o agente ler paginas institucionais e de vagas.
 */
function htmlParaTexto(html) {
  let texto = String(html);

  const titulo = texto.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || null;
  const descricao =
    texto.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || null;

  texto = texto
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|header|aside|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  texto = texto
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  texto = texto
    .split('\n')
    .map((linha) => linha.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return { titulo, descricao, texto };
}

async function lerPagina({ url, maxCaracteres = 15000, signal }) {
  const resposta = await fetchSeguro(url, {
    metodo: 'GET',
    cabecalhos: {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'User-Agent': 'ClavesCRM/2.0 (+prospeccao B2B; contato@claves.com.br)',
    },
    timeoutMs: 25000,
    maxBytes: 3 * 1024 * 1024,
    signal,
  });

  if (!resposta.ok) {
    return { url, ok: false, status: resposta.status, erro: `HTTP ${resposta.status}` };
  }

  const tipo = String(resposta.cabecalhos.get('content-type') || '');
  const bruto = resposta.texto();

  if (tipo.includes('application/json')) {
    return {
      url: resposta.urlFinal,
      ok: true,
      tipo: 'json',
      lidoEm: new Date().toISOString(),
      conteudo: bruto.slice(0, maxCaracteres),
    };
  }
  if (!tipo.includes('text/html') && !tipo.includes('text/plain') && !tipo.includes('xml')) {
    return { url, ok: false, erro: `Tipo de conteudo nao suportado: ${tipo || 'desconhecido'}` };
  }

  const { titulo, descricao, texto } = htmlParaTexto(bruto);
  return {
    url: resposta.urlFinal,
    ok: true,
    tipo: 'html',
    titulo,
    descricao,
    lidoEm: new Date().toISOString(),
    truncado: texto.length > maxCaracteres,
    conteudo: texto.slice(0, maxCaracteres),
  };
}

module.exports = {
  PROVEDORES_BUSCA,
  CONTEXTO_CRIPTO,
  buscaDisponivel,
  buscar,
  lerPagina,
  htmlParaTexto,
};
