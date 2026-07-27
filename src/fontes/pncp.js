'use strict';

/**
 * Radar PNCP — Portal Nacional de Contratacoes Publicas.
 *
 * API publica e gratuita, sem cadastro:
 *   https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao
 *
 * Por que isso importa para o Tier 1: a empresa privada que acabou de vencer
 * uma licitacao de fornecimento de mao de obra medica passa a ter, da noite
 * para o dia, dezenas de vagas para preencher com prazo contratual. E o sinal
 * de compra mais forte e mais verificavel do ICP — e ele e publico.
 *
 * Atencao ao lado inverso: o orgao que ABRIU a licitacao normalmente e
 * anti-persona (contrata por concurso). Quem interessa e o VENCEDOR privado.
 */

const { fetchSeguro } = require('../security/ssrf');

const BASE = 'https://pncp.gov.br/api/consulta/v1';

// Modalidades relevantes para contratacao de servicos medicos.
const MODALIDADES = {
  1: 'Leilao eletronico',
  4: 'Concorrencia eletronica',
  6: 'Pregao eletronico',
  8: 'Dispensa de licitacao',
  9: 'Inexigibilidade',
  12: 'Credenciamento',
};

// Termos que caracterizam contratacao de servico medico/saude.
const TERMOS_SAUDE = [
  'medic', 'saude', 'saúde', 'hospital', 'clinic', 'clínic', 'ambulator',
  'plantao', 'plantão', 'sobreaviso', 'enfermag', 'assistencia a saude',
  'assistência à saúde', 'ocupacional', 'pronto socorro', 'pronto-socorro',
  'upa', 'samu', 'psf', 'esf', 'atencao basica', 'atenção básica',
  'especialidade', 'exames', 'diagnostic', 'diagnóstic', 'telemedicina',
];

function pareceServicoMedico(texto) {
  const alvo = String(texto || '').toLowerCase();
  return TERMOS_SAUDE.some((termo) => alvo.includes(termo));
}

function formatarData(data) {
  const d = data instanceof Date ? data : new Date(data);
  const ano = d.getUTCFullYear();
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dia = String(d.getUTCDate()).padStart(2, '0');
  return `${ano}${mes}${dia}`;
}

function resumirContratacao(item) {
  const unidade = item.unidadeOrgao || {};
  return {
    objeto: String(item.objetoCompra || '').slice(0, 600),
    modalidade: item.modalidadeNome || MODALIDADES[item.modalidadeId] || null,
    valorEstimado: item.valorTotalEstimado ?? null,
    dataPublicacao: item.dataPublicacaoPncp || null,
    dataAberturaProposta: item.dataAberturaProposta || null,
    dataEncerramentoProposta: item.dataEncerramentoProposta || null,
    situacao: item.situacaoCompraNome || null,
    orgao: {
      razaoSocial: item.orgaoEntidade?.razaoSocial || null,
      cnpj: item.orgaoEntidade?.cnpj || null,
      esfera: item.orgaoEntidade?.esferaId || null,
    },
    unidade: {
      nome: unidade.nomeUnidade || null,
      municipio: unidade.municipioNome || null,
      uf: unidade.ufSigla || null,
    },
    linkPncp: item.numeroControlePNCP
      ? `https://pncp.gov.br/app/editais/${String(item.numeroControlePNCP).replace(/\//g, '-')}`
      : null,
    numeroControlePNCP: item.numeroControlePNCP || null,
  };
}

/**
 * Busca contratacoes publicadas num periodo, filtrando por servicos de saude.
 *
 * @param {object} opcoes
 * @param {number} [opcoes.diasAtras=60]  janela retroativa
 * @param {string} [opcoes.uf]            sigla do estado (ex.: 'SP')
 * @param {number[]} [opcoes.modalidades] codigos de modalidade
 * @param {number} [opcoes.maxResultados=40]
 */
async function buscarContratacoesSaude(opcoes = {}) {
  const {
    diasAtras = 60,
    uf = null,
    modalidades = [6, 4, 12, 8],
    maxResultados = 40,
    signal,
  } = opcoes;

  const fim = new Date();
  const inicio = new Date(fim.getTime() - Math.min(diasAtras, 365) * 24 * 60 * 60 * 1000);

  const achados = [];
  const erros = [];

  for (const modalidade of modalidades) {
    if (achados.length >= maxResultados) break;

    const params = new URLSearchParams({
      dataInicial: formatarData(inicio),
      dataFinal: formatarData(fim),
      codigoModalidadeContratacao: String(modalidade),
      pagina: '1',
      tamanhoPagina: '50',
    });
    if (uf) params.set('uf', String(uf).toUpperCase().slice(0, 2));

    try {
      const resposta = await fetchSeguro(`${BASE}/contratacoes/publicacao?${params.toString()}`, {
        metodo: 'GET',
        cabecalhos: { Accept: 'application/json' },
        timeoutMs: 30000,
        maxBytes: 6 * 1024 * 1024,
        signal,
      });

      // O PNCP devolve 204 quando nao ha resultado para o filtro.
      if (resposta.status === 204) continue;
      if (!resposta.ok) {
        erros.push(`modalidade ${modalidade}: HTTP ${resposta.status}`);
        continue;
      }

      const dados = JSON.parse(resposta.texto());
      const itens = Array.isArray(dados?.data) ? dados.data : [];

      for (const item of itens) {
        if (achados.length >= maxResultados) break;
        if (!pareceServicoMedico(item.objetoCompra)) continue;
        achados.push(resumirContratacao(item));
      }
    } catch (erro) {
      erros.push(`modalidade ${modalidade}: ${erro.message}`);
    }
  }

  achados.sort((a, b) => (b.valorEstimado || 0) - (a.valorEstimado || 0));

  return {
    periodo: { de: formatarData(inicio), ate: formatarData(fim) },
    uf: uf || 'todas',
    total: achados.length,
    contratacoes: achados,
    avisos: erros.length ? erros : undefined,
    observacao:
      'O orgao listado e o CONTRATANTE publico (normalmente anti-persona). O lead Tier 1 e a EMPRESA PRIVADA que vence este contrato e precisa escalar corpo clinico para executa-lo. Use busca web para descobrir o vencedor/homologado.',
  };
}

module.exports = { buscarContratacoesSaude, MODALIDADES, pareceServicoMedico };
