'use strict';

/**
 * Ferramentas do agente de prospeccao.
 *
 * Cada ferramenta tem `esquema` (JSON Schema aceito pelos tres provedores) e
 * `executar`. As ferramentas de registro (`registrar_*`, `descartar_*`) nao
 * fazem I/O externo: elas sao o canal de saida estruturada do agente — e como
 * o modelo "devolve" um lead sem precisarmos parsear texto livre.
 */

const pncp = require('../fontes/pncp');
const buscaWeb = require('../fontes/buscaWeb');

const ESQUEMA_FONTE = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL publica exata onde a informacao foi encontrada.' },
    titulo: { type: 'string', description: 'Titulo da pagina ou do documento.' },
  },
  required: ['url'],
};

const ESQUEMA_DECISOR = {
  type: 'object',
  properties: {
    nomeCompleto: {
      type: 'string',
      description:
        'Nome completo da pessoa, exatamente como aparece na fonte publica. Nunca invente, nunca abrevie, nunca use "Sr(a). Responsavel".',
    },
    cargo: {
      type: 'string',
      description: 'Cargo exato como consta na fonte (ex.: "Diretora Medica", "Head de Gente & Gestao").',
    },
    area: {
      type: 'string',
      enum: ['operacoes_medicas', 'medico', 'rh_gente', 'executivo_ceo', 'expansao', 'unidade', 'outro'],
    },
    senioridade: { type: 'string', enum: ['c_level', 'diretoria', 'gerencia', 'coordenacao', 'outro'] },
    linkedinUrl: { type: 'string', description: 'URL do perfil no LinkedIn, se encontrada.' },
    emailPublico: {
      type: 'string',
      description: 'Somente se divulgado publicamente pela propria empresa. Nunca adivinhe padrao de e-mail.',
    },
    telefonePublico: { type: 'string', description: 'Somente se divulgado publicamente.' },
    fonteUrl: { type: 'string', description: 'URL que comprova nome + cargo desta pessoa.' },
    fonteTitulo: { type: 'string' },
    dataDaEvidencia: {
      type: 'string',
      description:
        'Data da fonte no formato AAAA-MM-DD (ou AAAA-MM). E o que prova que o dado e ATUAL. Se a fonte nao tem data, escreva "sem_data".',
    },
    statusAtual: {
      type: 'string',
      enum: ['confirmado_atual', 'provavel_atual', 'nao_confirmado', 'saiu_da_empresa'],
      description:
        'confirmado_atual = fonte dos ultimos 12 meses confirma a pessoa no cargo. saiu_da_empresa = nao registrar como decisor.',
    },
    trechoEvidencia: {
      type: 'string',
      description: 'Trecho literal da fonte que comprova nome e cargo (ate 300 caracteres).',
    },
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
  },
  required: ['nomeCompleto', 'cargo', 'fonteUrl', 'statusAtual', 'confianca'],
};

const FERRAMENTAS_PESQUISA = [
  {
    nome: 'pncp_licitacoes_saude',
    descricao:
      'Consulta o Portal Nacional de Contratacoes Publicas (PNCP) por contratacoes de servicos medicos e de saude publicadas recentemente. Use no Tier 1: uma licitacao grande de fornecimento de medicos indica que a EMPRESA PRIVADA vencedora vai precisar escalar corpo clinico com prazo contratual. Depois de achar a contratacao, use busca web para descobrir quem venceu/foi homologado — o vencedor e o lead, nao o orgao publico.',
    esquema: {
      type: 'object',
      properties: {
        diasAtras: {
          type: 'integer',
          description: 'Janela retroativa em dias (padrao 60, maximo 365).',
        },
        uf: { type: 'string', description: 'Sigla do estado para filtrar, ex.: SP, MG, BA. Omita para busca nacional.' },
        maxResultados: { type: 'integer', description: 'Maximo de contratacoes a retornar (padrao 40).' },
      },
      required: [],
    },
    async executar(entrada, contexto) {
      return pncp.buscarContratacoesSaude({
        diasAtras: Number(entrada.diasAtras) || 60,
        uf: entrada.uf || null,
        maxResultados: Math.min(Number(entrada.maxResultados) || 40, 60),
        signal: contexto.signal,
      });
    },
  },
  {
    nome: 'buscar_web',
    descricao:
      'Faz uma busca na web e retorna titulos, URLs e trechos. Use consultas especificas e em portugues. Exemplos: "site:linkedin.com/in diretor medico <empresa>", "<empresa> vagas medico do trabalho", "<empresa> vence licitacao medicos 2026", "<empresa> nova unidade inauguracao".',
    esquema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'A consulta de busca.' },
        quantidade: { type: 'integer', description: 'Quantidade de resultados (padrao 10, maximo 20).' },
      },
      required: ['consulta'],
    },
    async executar(entrada, contexto) {
      return buscaWeb.buscar({
        consulta: String(entrada.consulta || '').slice(0, 400),
        quantidade: Math.min(Number(entrada.quantidade) || 10, 20),
        signal: contexto.signal,
      });
    },
  },
  {
    nome: 'ler_pagina',
    descricao:
      'Abre uma URL publica e devolve o texto legivel da pagina. Use para ler a pagina "Quem somos"/"Nossa equipe" da empresa, paginas de vagas, noticias e perfis publicos. Sempre leia a fonte antes de afirmar nome e cargo de um decisor.',
    esquema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL completa comecando com https://' },
      },
      required: ['url'],
    },
    async executar(entrada, contexto) {
      return buscaWeb.lerPagina({ url: String(entrada.url || ''), signal: contexto.signal });
    },
  },
];

/** Fase 1 — o agente lista empresas candidatas antes de aprofundar. */
const FERRAMENTA_CANDIDATA = {
  nome: 'registrar_candidata',
  descricao:
    'Registra uma EMPRESA CONTRATANTE candidata encontrada na descoberta — ou seja, uma empresa que pode comprar o servico da Claves. NUNCA registre um medico, candidato ou curriculo aqui: se voce achou uma vaga, o registro e a empresa que publicou a vaga, nao a vaga nem o profissional. Chame uma vez por empresa. Nao aprofunde aqui — o aprofundamento e uma etapa separada.',
  esquema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Razao social ou nome comercial da empresa.' },
      site: { type: 'string', description: 'Site oficial, se conhecido.' },
      cidade: { type: 'string' },
      uf: { type: 'string' },
      tierProvavel: { type: 'integer', description: 'Tier 1, 2, 3 ou 4.' },
      motivo: {
        type: 'string',
        description: 'Em uma frase: por que esta empresa parece ter a dor do tier indicado, e o que voce ja viu.',
      },
      sinalInicial: { type: 'string', description: 'O sinal de compra observado (licitacao, expansao, vagas, captacao...).' },
      fonteUrl: { type: 'string', description: 'URL onde a empresa foi encontrada.' },
    },
    required: ['nome', 'tierProvavel', 'motivo'],
  },
  async executar(entrada, contexto) {
    contexto.candidatas.push({
      nome: String(entrada.nome).slice(0, 200),
      site: entrada.site || null,
      cidade: entrada.cidade || null,
      uf: entrada.uf || null,
      tierProvavel: Number(entrada.tierProvavel) || null,
      motivo: String(entrada.motivo || '').slice(0, 1000),
      sinalInicial: entrada.sinalInicial || null,
      fonteUrl: entrada.fonteUrl || null,
    });
    contexto.emitir('candidata', {
      nome: entrada.nome,
      tier: entrada.tierProvavel,
      motivo: entrada.motivo,
    });
    return { registrada: true, totalAteAgora: contexto.candidatas.length };
  },
};

/** Fase 2 — dossie completo do lead qualificado. */
const FERRAMENTA_DOSSIE = {
  nome: 'registrar_lead_qualificado',
  descricao:
    'Registra o dossie final de UMA EMPRESA CONTRATANTE qualificada — a empresa que vai contratar e pagar pelo servico da Claves. Nunca um medico ou candidato. Chame exatamente uma vez, ao final da investigacao, com tudo que voce comprovou. Todo dado factual precisa vir de uma fonte que voce realmente abriu.',
  esquema: {
    type: 'object',
    properties: {
      empresa: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          nomeFantasia: { type: 'string' },
          cnpj: { type: 'string', description: 'Somente se encontrado em fonte publica.' },
          site: { type: 'string' },
          cidade: { type: 'string' },
          uf: { type: 'string' },
          abrangencia: {
            type: 'string',
            enum: ['nacional', 'multiestadual', 'estadual', 'regional', 'municipal', 'desconhecida'],
          },
          porteEstimado: { type: 'string', enum: ['grande', 'medio', 'pequeno', 'desconhecido'] },
          segmento: { type: 'string', description: 'Ex.: SST/medicina ocupacional, rede de dialise, hospital geral, healthtech.' },
          linkedinEmpresa: { type: 'string' },
        },
        required: ['nome'],
      },
      tier: { type: 'integer', description: 'Tier definitivo: 1, 2, 3 ou 4.' },
      justificativaTier: { type: 'string', description: 'Por que este tier e nao outro, com base nas evidencias.' },
      porqueClaves: {
        type: 'string',
        description:
          'O CENTRO DO DOSSIE: por que esta empresa precisa da Claves AGORA. Conecte o sinal de compra concreto que voce achou a dor de reposicao em escala. Especifico e verificavel, nunca generico.',
      },
      dorIdentificada: { type: 'string', description: 'A dor operacional concreta observada.' },
      sinaisDeCompra: {
        type: 'array',
        description: 'Os gatilhos que tornam a abordagem oportuna agora.',
        items: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['licitacao', 'expansao', 'investimento', 'volume_vagas', 'novo_contrato', 'nova_unidade', 'rotatividade', 'outro'],
            },
            descricao: { type: 'string' },
            dataDoSinal: { type: 'string', description: 'AAAA-MM-DD ou AAAA-MM.' },
            fonteUrl: { type: 'string' },
            fonteTitulo: { type: 'string' },
          },
          required: ['tipo', 'descricao', 'fonteUrl'],
        },
      },
      vagasAbertas: {
        type: 'array',
        description:
          'EVIDENCIA DA DOR desta empresa: vagas medicas que ELA tem abertas publicamente. Isso mede o tamanho do problema que a Claves resolveria — nao e uma lista de oportunidades para medicos.',
        items: {
          type: 'object',
          properties: {
            titulo: { type: 'string' },
            especialidade: { type: 'string' },
            cidade: { type: 'string' },
            uf: { type: 'string' },
            diasAberta: { type: 'integer', description: 'Ha quantos dias a vaga esta publicada, se der para saber.' },
            fonteUrl: { type: 'string' },
          },
          required: ['titulo'],
        },
      },
      volumeEstimadoVagas: {
        type: 'integer',
        description: 'Estimativa de vagas medicas simultaneas em aberto. Use 0 se nao foi possivel estimar.',
      },
      decisores: {
        type: 'array',
        description:
          'Pessoas que APROVAM A COMPRA de um servico de recrutamento dentro desta empresa (Diretor de Operacoes Medicas, Diretor Medico, Head de Gente/RH, CEO, Diretor Tecnico, gestor da unidade). NAO sao medicos sendo recrutados. Nome completo e cargo comprovados em fonte publica ATUAL. Prefira poucos e certos a muitos e duvidosos. Nunca inclua quem ja saiu da empresa.',
        items: ESQUEMA_DECISOR,
      },
      antiPersona: {
        type: 'object',
        properties: {
          atingido: { type: 'boolean' },
          codigos: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'clinica_pequena_vaga_pontual',
                'clinica_popular_baixo_custo',
                'quer_banco_de_curriculos',
                'exige_garantia_de_contratacao',
                'orgao_publico_concurso',
                'intermediario_oportunista',
              ],
            },
          },
          justificativa: { type: 'string' },
        },
        required: ['atingido'],
      },
      score: {
        type: 'integer',
        description:
          'Nota 0-100 de prioridade comercial. Considere: forca do tier, quantidade e recencia dos sinais, volume de vagas, qualidade dos decisores encontrados.',
      },
      confianca: {
        type: 'string',
        enum: ['alta', 'media', 'baixa'],
        description: 'Sua confianca na solidez das evidencias deste dossie.',
      },
      ganchoAbordagem: {
        type: 'string',
        description: 'Uma frase de abertura que o SDR pode usar, ancorada no sinal concreto que voce achou.',
      },
      proximoPasso: { type: 'string', description: 'A acao comercial recomendada.' },
      fontes: { type: 'array', items: ESQUEMA_FONTE, description: 'Todas as URLs que voce realmente abriu.' },
      observacoes: { type: 'string', description: 'Lacunas, duvidas ou o que nao foi possivel confirmar.' },
    },
    required: ['empresa', 'tier', 'porqueClaves', 'antiPersona', 'score', 'confianca'],
  },
  async executar(entrada, contexto) {
    contexto.dossies.push(entrada);
    contexto.emitir('dossie', {
      empresa: entrada.empresa?.nome,
      tier: entrada.tier,
      score: entrada.score,
      decisores: (entrada.decisores || []).length,
      antiPersona: !!entrada.antiPersona?.atingido,
    });
    return { registrado: true };
  },
};

const FERRAMENTA_DESCARTE = {
  nome: 'descartar_candidata',
  descricao:
    'Descarta uma empresa que se encaixa na anti-persona ou que nao tem a dor do ICP. Descartar bem economiza municao do time comercial — use sem hesitar.',
  esquema: {
    type: 'object',
    properties: {
      nome: { type: 'string' },
      codigoAntiPersona: {
        type: 'string',
        enum: [
          'clinica_pequena_vaga_pontual',
          'clinica_popular_baixo_custo',
          'quer_banco_de_curriculos',
          'exige_garantia_de_contratacao',
          'orgao_publico_concurso',
          'intermediario_oportunista',
          'fora_do_icp',
        ],
      },
      motivo: { type: 'string', description: 'Evidencia concreta que sustenta o descarte.' },
      fonteUrl: { type: 'string' },
    },
    required: ['nome', 'codigoAntiPersona', 'motivo'],
  },
  async executar(entrada, contexto) {
    contexto.descartes.push({
      nome: String(entrada.nome).slice(0, 200),
      codigoAntiPersona: entrada.codigoAntiPersona,
      motivo: String(entrada.motivo || '').slice(0, 1000),
      fonteUrl: entrada.fonteUrl || null,
    });
    contexto.emitir('descarte', {
      nome: entrada.nome,
      codigo: entrada.codigoAntiPersona,
      motivo: entrada.motivo,
    });
    return { descartada: true };
  },
};

/**
 * Monta o conjunto de ferramentas de uma fase.
 * `incluirWeb` fica false quando o provedor tem busca nativa (Anthropic) —
 * nesse caso o modelo usa as server tools em vez das nossas.
 */
function montar({ fase, incluirWeb }) {
  const web = FERRAMENTAS_PESQUISA.filter((f) => {
    if (f.nome === 'pncp_licitacoes_saude') return fase === 'descoberta';
    return incluirWeb;
  });

  if (fase === 'descoberta') return [...web, FERRAMENTA_CANDIDATA, FERRAMENTA_DESCARTE];
  return [...web, FERRAMENTA_DOSSIE, FERRAMENTA_DESCARTE];
}

module.exports = { montar, FERRAMENTAS_PESQUISA, FERRAMENTA_DOSSIE };
