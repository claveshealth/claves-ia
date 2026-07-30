'use strict';

/**
 * Busca de decisores no LinkedIn.
 *
 * COMO ISSO FUNCIONA — e por que nao e scraping.
 *
 * linkedin.com/in/* nao e legivel por robo: a LinkedIn devolve muro de login
 * (999/403) para qualquer requisicao sem sessao, e raspar o site viola os
 * termos de uso e derruba o IP. Entao NAO lemos o LinkedIn.
 *
 * O que fazemos e consultar o INDICE de um buscador (Serper/Google, Brave)
 * restrito a `site:linkedin.com/in`. O buscador ja rastreou a versao publica
 * do perfil — aquela que qualquer pessoa ve deslogada — e devolve titulo,
 * URL e trecho. O titulo publico do LinkedIn tem formato estavel:
 *
 *     "Nome Sobrenome - Cargo - Empresa | LinkedIn"
 *
 * Disso extraimos nome, cargo e empresa com confianca alta, sem tocar no
 * servidor da LinkedIn e sem violar termo nenhum. E o mesmo dado que aparece
 * numa busca no Google, so estruturado.
 *
 * LIMITE HONESTO: o indice do buscador pode estar defasado em relacao ao
 * perfil. Por isso todo retorno carrega `confianca` e o motivo, e o
 * `empresaConfere` diz se a empresa do titulo bate com a empresa alvo. Quem
 * mudou de emprego recentemente pode aparecer com o cargo antigo — e o
 * orquestrador ja descarta quem vier marcado como `saiu_da_empresa`.
 */

const buscaWeb = require('./buscaWeb');

const RE_PERFIL = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i;
const RE_EMPRESA = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/company\/[^/?#]+/i;

/**
 * Cargos que aprovam a compra de recrutamento medico. Ordenados por prioridade
 * comercial — quem decide vem antes de quem influencia.
 */
const CARGOS_DECISORES = [
  'diretor de operacoes medicas',
  'diretor medico',
  'diretora medica',
  'diretor tecnico',
  'diretor assistencial',
  'head medico',
  'gerente medico',
  'coordenador medico',
  'head de gente',
  'diretor de gente',
  'diretor de recursos humanos',
  'gerente de recursos humanos',
  'gerente de recrutamento',
  'head de recrutamento',
  'coordenador de recrutamento',
  'business partner',
  'diretor de operacoes',
  'head de operacoes',
  'diretor de expansao',
  'ceo',
  'diretor geral',
  'socio',
  'fundador',
  'presidente',
];

const RUIDO_URL = /\/(posts|pulse|jobs|feed|company|school|groups|events)\//i;

function semAcento(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Normaliza nome de empresa para comparar "Grupo Opty S.A." com "opty". */
function chaveEmpresa(nome) {
  return semAcento(nome)
    .replace(/\b(ltda|s\.?a\.?|eireli|me|epp|grupo|instituto|associacao|holding|participacoes|brasil)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Extrai nome / cargo / empresa do titulo publico do perfil.
 * Formatos aceitos (o LinkedIn usa hifen, en-dash ou em-dash):
 *   "Nome - Cargo - Empresa | LinkedIn"
 *   "Nome - Cargo | LinkedIn"
 *   "Nome | LinkedIn"
 */
function analisarTitulo(titulo) {
  let base = String(titulo || '').trim();

  // Remove o sufixo do LinkedIn em pt e en.
  base = base.replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, '').trim();
  if (!base) return null;

  const partes = base
    .split(/\s+[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const nome = partes[0] || null;
  if (!nome) return null;

  // Titulo de post ("Nome on LinkedIn: ...") nao e perfil.
  if (/\bon LinkedIn\b|\bno LinkedIn\b/i.test(titulo)) return null;

  return {
    nome,
    cargo: partes[1] || null,
    empresaNoTitulo: partes[2] || null,
  };
}

function pontuarCargo(cargo) {
  if (!cargo) return 0;
  const alvo = semAcento(cargo);
  for (let i = 0; i < CARGOS_DECISORES.length; i += 1) {
    if (alvo.includes(CARGOS_DECISORES[i])) {
      // Quanto mais no topo da lista, mais decisor.
      return Math.round(100 - (i / CARGOS_DECISORES.length) * 45);
    }
  }
  return 20; // e um perfil, mas o cargo nao parece decisor de compra
}

/**
 * Confianca do registro. Alta exige que a empresa do titulo bata com a alvo —
 * e o que evita cadastrar alguem que so foi mencionado junto da empresa.
 */
function avaliar({ cargo, empresaNoTitulo, empresaAlvo, trecho }) {
  const chaveAlvo = chaveEmpresa(empresaAlvo);
  const chaveTitulo = chaveEmpresa(empresaNoTitulo);
  const noTrecho = chaveAlvo && chaveEmpresa(trecho).includes(chaveAlvo);

  const confereTitulo = Boolean(chaveAlvo && chaveTitulo && (chaveTitulo.includes(chaveAlvo) || chaveAlvo.includes(chaveTitulo)));
  const empresaConfere = confereTitulo || Boolean(noTrecho);

  let confianca = 'baixa';
  let motivo = 'Empresa nao confirmada no titulo nem no trecho do perfil.';

  if (confereTitulo && cargo) {
    confianca = 'alta';
    motivo = 'Nome, cargo e empresa vieram do titulo publico do perfil.';
  } else if (empresaConfere && cargo) {
    confianca = 'media';
    motivo = 'Cargo do titulo; empresa confirmada apenas no trecho indexado.';
  } else if (cargo) {
    confianca = 'baixa';
    motivo = 'Cargo do titulo, mas a empresa alvo nao aparece — pode ter trocado de emprego.';
  }

  return { empresaConfere, confianca, motivo };
}

/** Monta as consultas. Varias formulacoes porque o indice responde diferente a cada uma. */
function montarConsultas({ empresa, cargos, regiao }) {
  const nome = String(empresa || '').trim();
  const consultas = [];
  const lista = (cargos && cargos.length ? cargos : ['diretor medico', 'diretor de operacoes', 'RH', 'CEO'])
    .slice(0, 6);

  for (const cargo of lista) {
    consultas.push(`site:linkedin.com/in "${nome}" ${cargo}`);
  }
  // Uma consulta ampla, sem cargo: pega quem tem titulo fora do padrao.
  consultas.push(`site:linkedin.com/in "${nome}"`);
  if (regiao) consultas.push(`site:linkedin.com/in "${nome}" ${regiao}`);

  return consultas;
}

/**
 * Busca decisores de uma empresa. Retorna perfis deduplicados por URL,
 * ordenados por (confianca, aderencia do cargo).
 */
async function buscarPessoas({ empresa, cargos = [], regiao = null, maxResultados = 12, signal }) {
  if (!empresa) throw new Error('Informe o nome da empresa para buscar decisores.');
  if (!buscaWeb.buscaDisponivel()) {
    throw new Error(
      'A busca no LinkedIn depende de uma API de busca configurada (Serper, Brave ou Tavily) em Configuracoes -> Integracoes. ' +
        'O LinkedIn nao permite leitura direta por robo: o CRM consulta o indice publico do buscador.'
    );
  }

  const consultas = montarConsultas({ empresa, cargos, regiao });
  const porUrl = new Map();
  const consultasUsadas = [];
  const falhas = [];

  for (const consulta of consultas) {
    if (signal?.aborted) break;
    if (porUrl.size >= maxResultados * 2) break;

    let resposta;
    try {
      resposta = await buscaWeb.buscar({ consulta, quantidade: 10, signal });
    } catch (falha) {
      falhas.push({ consulta, erro: falha.message });
      continue;
    }
    consultasUsadas.push(consulta);

    for (const resultado of resposta.resultados) {
      const url = String(resultado.url || '');
      if (!RE_PERFIL.test(url)) continue;
      if (RUIDO_URL.test(url.replace(/^https?:\/\/[^/]+/, ''))) continue;

      // Normaliza a URL para deduplicar (sem query, sem barra final, sem locale).
      const limpa = url.split(/[?#]/)[0].replace(/\/$/, '').replace(/^https?:\/\/[a-z]{2,3}\./i, 'https://www.');
      if (porUrl.has(limpa)) continue;

      const analisado = analisarTitulo(resultado.titulo);
      if (!analisado?.nome) continue;

      const avaliacao = avaliar({
        cargo: analisado.cargo,
        empresaNoTitulo: analisado.empresaNoTitulo,
        empresaAlvo: empresa,
        trecho: resultado.trecho,
      });

      porUrl.set(limpa, {
        nomeCompleto: analisado.nome,
        cargo: analisado.cargo,
        empresaNoTitulo: analisado.empresaNoTitulo,
        linkedinUrl: limpa,
        fonteUrl: limpa,
        fonteTitulo: resultado.titulo || null,
        trechoEvidencia: (resultado.trecho || '').slice(0, 400) || null,
        indexadoEm: resultado.publicadoEm || null,
        empresaConfere: avaliacao.empresaConfere,
        confianca: avaliacao.confianca,
        motivoConfianca: avaliacao.motivo,
        pontuacaoCargo: pontuarCargo(analisado.cargo),
        // O agente precisa confirmar em outra fonte antes de cravar; o indice
        // pode estar defasado em relacao ao perfil real.
        statusAtual: avaliacao.confianca === 'alta' ? 'provavel_atual' : 'nao_confirmado',
      });
    }
  }

  const ordem = { alta: 3, media: 2, baixa: 1 };
  const pessoas = [...porUrl.values()]
    .sort((a, b) => {
      const porConfianca = (ordem[b.confianca] || 0) - (ordem[a.confianca] || 0);
      if (porConfianca !== 0) return porConfianca;
      return b.pontuacaoCargo - a.pontuacaoCargo;
    })
    .slice(0, maxResultados);

  return {
    empresa,
    total: pessoas.length,
    pessoas,
    consultasUsadas,
    falhas,
    aviso:
      pessoas.length === 0
        ? 'Nenhum perfil publico indexado foi encontrado. Isso NAO significa que nao existe decisor — significa que o indice nao devolveu. Registre como lacuna, nao invente nome.'
        : 'Dados vindos do indice publico de busca. Confirme o cargo numa segunda fonte antes de marcar como confirmado_atual.',
  };
}

/** Localiza a pagina institucional da empresa no LinkedIn. */
async function buscarEmpresa({ empresa, signal }) {
  if (!empresa) throw new Error('Informe o nome da empresa.');
  if (!buscaWeb.buscaDisponivel()) {
    throw new Error('A busca no LinkedIn depende de uma API de busca configurada em Configuracoes -> Integracoes.');
  }

  const resposta = await buscaWeb.buscar({
    consulta: `site:linkedin.com/company "${empresa}"`,
    quantidade: 5,
    signal,
  });

  const paginas = resposta.resultados
    .filter((r) => RE_EMPRESA.test(String(r.url || '')))
    .map((r) => ({
      url: String(r.url).split(/[?#]/)[0].replace(/\/$/, ''),
      titulo: r.titulo || null,
      trecho: (r.trecho || '').slice(0, 300) || null,
    }));

  return { empresa, total: paginas.length, paginas };
}

module.exports = {
  CARGOS_DECISORES,
  buscarPessoas,
  buscarEmpresa,
  analisarTitulo,
  chaveEmpresa,
  pontuarCargo,
};
