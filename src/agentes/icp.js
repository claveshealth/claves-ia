'use strict';

/**
 * Base de conhecimento do ICP da Claves Health.
 *
 * Este arquivo e a "personalidade comercial" do agente: os quatro tiers, os
 * sinais de compra que disparam abordagem, quem decide em cada um e — tao
 * importante quanto — a anti-persona, que faz o agente descartar lead ruim
 * antes de gastar tempo do SDR.
 *
 * Alterar este arquivo muda o comportamento de prospeccao inteiro.
 */

const TIERS = {
  1: {
    id: 1,
    nome: 'Gestoras de saude corporativa, SST e grandes redes assistenciais',
    resumo: 'Dor de escala: dezenas de vagas de medico abertas ao mesmo tempo, em varias cidades.',
    quemE:
      'Empresas que assumem contratos de medicina do trabalho/ocupacional ou operacoes assistenciais de grande porte espalhadas por multiplos estados e cidades. Nao tem uma vaga — tem dezenas de vagas de medico abertas ao mesmo tempo, cronicamente, porque a operacao nunca para de crescer ou de perder gente.',
    dorReal:
      'Vaga parada custa contrato. Cada unidade sem medico e receita perdida e risco de quebra de SLA com o cliente corporativo ou com o poder publico. Precisam de reposicao em volume, em varias cidades, com velocidade — o RH interno nao da conta sozinho.',
    sinaisDeCompra: [
      'vitoria recente em licitacao ou contrato de fornecimento de medicos (radar PNCP)',
      'expansao anunciada',
      'captacao de investimento',
      'dezenas de vagas abertas simultaneamente em cidades diferentes',
    ],
    decisores: [
      'Diretor de Operacoes Medicas',
      'Diretor Medico',
      'Head de Gente / RH corporativo',
      'CEO (em empresas mid-market)',
    ],
    clienteEspelho:
      'DaVita Brasil — reestruturacao com recomposicao simultanea de equipes em diversas unidades, necessidade critica de velocidade: 195 profissionais em menos de 30 dias com alto indice de retencao. O retrato do Tier 1 — escala, multiplas unidades, reposicao continua. Observacao: a DaVita e rede de nefrologia/dialise; entra no Tier 1 pela dor de escala, nao pelo segmento SST puro. E o case-ponte que prova que o Tier 1 acomoda grandes redes assistenciais com essa dor.',
    ondeCacar: ['PNCP (ferramenta propria)', 'oHub', 'Google', 'LinkedIn', 'Lusha'],
    pesoBase: 100,
  },
  2: {
    id: 2,
    nome: 'Telemedicina ocupacional e plataformas digitais de SST',
    resumo: 'O produto delas e o medico do trabalho; o gargalo de receita e a oferta de medicos.',
    quemE:
      'Healthtechs que operam medicina do trabalho de forma remota/digital — emissao de ASO, laudos ocupacionais, teleconsulta ocupacional em escala nacional.',
    dorReal:
      'O produto delas e o medico do trabalho. Cada novo contrato corporativo fechado significa demanda imediata por mais corpo clinico credenciado. Crescem rapido e o gargalo e sempre a oferta de medicos — se nao escalam o corpo clinico, nao escalam a receita.',
    sinaisDeCompra: [
      'rodada de investimento',
      'novos contratos corporativos grandes',
      'anuncio de expansao de cobertura geografica',
      'vagas de medico do trabalho abertas ha semanas',
    ],
    decisores: [
      'Head Medico',
      'Head de Operacoes',
      'Fundadores / C-level (empresas jovens, decisao rapida e enxuta)',
    ],
    clienteEspelho: null,
    ondeCacar: ['LinkedIn', 'associacoes de healthtech', 'Lusha'],
    pesoBase: 85,
  },
  3: {
    id: 3,
    nome: 'Redes de clinicas ocupacionais multiunidade e credenciadoras',
    resumo: 'Mesma dor de reposicao do Tier 1, porem pulverizada geograficamente.',
    quemE:
      'Redes fisicas de clinicas ocupacionais com varias unidades, e credenciadoras que precisam manter uma malha de medicos ativa em muitas cidades.',
    dorReal:
      'Mesma dor de reposicao do Tier 1, mas pulverizada geograficamente. Perdem medico em uma cidade e a unidade fica descoberta; recrutar localmente em dezenas de pracas e inviavel para o RH interno.',
    sinaisDeCompra: [
      'abertura de novas unidades',
      'expansao para novas cidades',
      'rotatividade alta',
      'vagas repetidas nas mesmas pracas',
    ],
    decisores: ['Gerente de RH', 'Coordenador de Operacoes', 'Diretor de Expansao'],
    clienteEspelho: null,
    ondeCacar: ['oHub (1.400+ empresas listadas)', 'Google Maps', 'Lusha'],
    pesoBase: 70,
  },
  4: {
    id: 4,
    nome: 'Telemedicina assistencial, hospitais e clinicas com vagas cronicas de especialistas',
    resumo: 'Montar ou repor corpo clinico multi-especialidade sob prazo de abertura/expansao.',
    quemE:
      'Operacoes assistenciais (nao-SST) — hospitais, clinicas de especialidades, telemedicina assistencial — que precisam montar ou repor corpo clinico em 10+ especialidades, tipicamente em eventos de expansao ou abertura de unidade.',
    dorReal:
      'Montar um corpo clinico multi-especialidade do zero, ou repor especialistas dificeis (que exigem RQE, subespecialidade), com prazo apertado para a operacao comecar/continuar rodando. Vaga de especialista fica aberta 30, 60, 90 dias — e dor publica e comprovada.',
    sinaisDeCompra: [
      'abertura de nova unidade',
      'vagas de especialista abertas ha mais de 30 dias',
      'expansao regional',
      'novo servico ou setor sendo inaugurado',
    ],
    decisores: ['Diretor Tecnico', 'Diretor Medico', 'Gestor da unidade', 'RH hospitalar'],
    clienteEspelho:
      'Hospital Sao Lucas/SP — abertura de nova unidade com demanda por profissionais tecnicos e biomedicos para inicio da operacao: 28 posicoes em 15 dias, operacao garantida desde o primeiro dia. Tier 4 classico — especialidades assistenciais + evento de expansao gerando pico de demanda.',
    ondeCacar: ['vagas abertas ha mais de 30 dias em portais', 'LinkedIn', 'indicacoes'],
    pesoBase: 60,
  },
};

/**
 * Anti-persona: perfis que parecem cliente, consomem energia comercial e
 * destroem margem. O agente precisa DESCARTAR, nao "guardar para depois".
 */
const ANTI_PERSONA = [
  {
    codigo: 'clinica_pequena_vaga_pontual',
    titulo: 'Clinica pequena / consultorio com vaga pontual',
    porque:
      'Uma vaga so, uma vez. Nao ha dor de escala nem recorrencia — o esforco de venda e entrega e o mesmo de uma conta grande, mas a receita e fracao. Ticket baixo com complexidade cheia. E exatamente o perfil que segurava a Claves em R$2-5 mil e dava retrabalho.',
    comoDetectar:
      'Uma unica unidade, uma unica vaga, sem historico de contratacao recorrente; quadro clinico pequeno; sem multiplas cidades.',
  },
  {
    codigo: 'clinica_popular_baixo_custo',
    titulo: 'Clinica popular / de baixo custo',
    porque:
      'Modelo de negocio comprime todo custo, inclusive o de contratacao. Nao enxerga R&S como investimento, so como despesa — vai pechinchar do inicio ao fim, questionar cada real e comparar com "colocar anuncio de graca". Margem negativa disfarcada de oportunidade.',
    comoDetectar:
      'Posicionamento publico de "consulta popular", "consulta a partir de R$X", preco como principal argumento de marca.',
  },
  {
    codigo: 'quer_banco_de_curriculos',
    titulo: 'Quer so acesso ao banco de curriculos',
    porque:
      'Nao quer o servico, quer a base. Tenta transformar uma consultoria de headhunting em um portal de vagas barato. Nao e cliente Claves — e comoditizacao do ativo mais valioso da empresa.',
    comoDetectar:
      'Busca declarada por "banco de curriculos", "acesso a base de medicos", "plataforma de curriculos", licenca de base.',
  },
  {
    codigo: 'exige_garantia_de_contratacao',
    titulo: 'Exige garantia de contratacao / de resultado',
    porque:
      'Fere a obrigacao de meio do contrato. Quem condiciona pagamento a contratacao efetiva transfere para a Claves um risco que nao e dela e sinaliza que nao entende (nem respeita) o servico.',
    comoDetectar:
      'Editais ou politicas de compra que exigem pagamento so por contratacao efetivada, "success fee" puro com risco integral no fornecedor.',
  },
  {
    codigo: 'orgao_publico_concurso',
    titulo: 'Orgao publico com contratacao por concurso',
    porque:
      'Nao pode contratar headhunting para preencher vaga — o rito e concurso/edital. Prospectar aqui e queimar tempo em algo juridicamente inviavel.',
    comoDetectar:
      'Ente publico direto (prefeitura, secretaria, autarquia) cujo provimento de vaga medica se da por concurso publico ou processo seletivo proprio.',
  },
  {
    codigo: 'intermediario_oportunista',
    titulo: 'Intermediario oportunista buscando subcontratacao a preco baixo',
    porque:
      'Quer usar a Claves como fornecedor de mao de obra dele, sugando margem e ficando entre a Claves e o cliente final. Volume aparente, lucro nenhum, e perda de relacionamento direto com quem decide.',
    comoDetectar:
      'Consultoria/RH terceirizado buscando fornecedor para revender, pedido de tabela de repasse, ausencia de acesso ao cliente final.',
  },
];

/**
 * Nota importante sobre o Tier 1 vs anti-persona 5: uma EMPRESA PRIVADA que
 * vence licitacao para fornecer medicos ao poder publico e Tier 1 (e um dos
 * sinais mais fortes). O que e anti-persona e o ORGAO PUBLICO que preenche a
 * propria vaga por concurso. O agente precisa distinguir os dois.
 */
const NOTA_PNCP =
  'Distinga sempre: o orgao publico que abre concurso para medico e ANTI-PERSONA. A empresa privada (OS, OSS, gestora, cooperativa ou prestadora) que VENCEU a licitacao e agora precisa escalar corpo clinico para executar o contrato e TIER 1 — e um dos sinais de compra mais fortes que existem.';

const STATUS_LEAD = [
  'novo',
  'qualificado',
  'contatado',
  'reuniao',
  'proposta',
  'ganho',
  'perdido',
  'descartado',
];

function tier(numero) {
  return TIERS[Number(numero)] || null;
}

/** Resumo compacto do ICP para injetar no prompt do sistema. */
function briefingCompleto() {
  const blocosTier = Object.values(TIERS)
    .map((t) => {
      const linhas = [
        `## TIER ${t.id} — ${t.nome}`,
        `Quem e: ${t.quemE}`,
        `Dor real: ${t.dorReal}`,
        `Sinais de compra: ${t.sinaisDeCompra.join('; ')}.`,
        `Quem decide: ${t.decisores.join('; ')}.`,
        `Onde cacar: ${t.ondeCacar.join(', ')}.`,
      ];
      if (t.clienteEspelho) linhas.push(`Cliente-espelho: ${t.clienteEspelho}`);
      return linhas.join('\n');
    })
    .join('\n\n');

  const blocoAnti = ANTI_PERSONA.map(
    (a, i) => `${i + 1}. [${a.codigo}] ${a.titulo}\n   Por que descartar: ${a.porque}\n   Como detectar: ${a.comoDetectar}`
  ).join('\n');

  return `${blocosTier}\n\n# ANTI-PERSONA — nao gastar municao\nEstes perfis parecem cliente, consomem energia comercial e destroem margem. O SDR nao avanca, nao agenda, nao insiste. Se o lead se encaixar em qualquer um deles, DESCARTE com o codigo correspondente.\n\n${blocoAnti}\n\nATENCAO: ${NOTA_PNCP}`;
}

module.exports = { TIERS, ANTI_PERSONA, STATUS_LEAD, NOTA_PNCP, tier, briefingCompleto };
