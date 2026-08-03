#!/usr/bin/env node
'use strict';

/**
 * Carrega no CRM os leads da varredura publica de 29/07/2026
 * (ver prospeccao/2026-07-29-varredura-publica.md).
 *
 *   node scripts/importar-prospeccao.js --dono sdr@claves.com.br
 *
 * Existe porque a primeira rodada de pesquisa foi feita fora do produto: sem
 * isto, a equipe comecaria com o kanban vazio e o trabalho ja feito ficaria
 * num markdown que ninguem abre.
 *
 * Idempotente: rodar duas vezes atualiza os leads em vez de duplicar.
 *
 * ATENCAO ao que NAO esta aqui: nenhum e-mail de decisor. A varredura nao
 * encontrou e-mail publico de ninguem, e o sistema nao deduz endereco. Quem for
 * abordar precisa achar o contato antes de usar o envio do CRM.
 */

const db = require('../src/store/db');
const { id: novoId } = require('../src/security/crypto');

const HOJE = '2026-07-29';

const LEADS = [
  {
    nome: 'VX Medical Innovation',
    site: 'https://vxmedicalinnovation.com.br',
    cidade: 'Belo Horizonte',
    uf: 'MG',
    segmento: 'Telerradiologia',
    tier: 2,
    score: 92,
    confianca: 'alta',
    vagas: 0,
    porqueClaves:
      'A propria empresa declarou publicamente que a escassez de radiologista e o gargalo do negocio: "a dificuldade central nao se resume a falta pontual de profissionais, mas a necessidade de escala para lidar com volume, prazo e cobertura 24 horas". Nenhum outro lead tem a dor admitida pelo cliente.',
    dor: '320+ radiologistas, 100 mil laudos/mes, 300+ hospitais, cobertura em 25 das 27 UFs. Meta de sair de R$ 45 mi (2025) para R$ 70 mi em 2026.',
    gancho:
      'Voces disseram, em maio, que o problema nao e falta pontual de radiologista — e escala para volume, prazo e cobertura 24h. Sair de R$ 45 para R$ 70 milhoes com 100 mil laudos/mes significa achar subespecialista para os turnos que ninguem quer. E esse pedaco do funil que a gente ataca.',
    proximoPasso:
      'Confirmar no ATS (vxmedicalinnovation.inhire.app) quantas vagas medicas estao abertas hoje e em quais subespecialidades.',
    observacoes:
      'Ja operam com 320 radiologistas: tem maquina de captacao propria. O pitch nao pode ser "ajudamos a achar medico", e sim velocidade de reposicao em subespecialidade gargalo (neuro, musculoesqueletico, mama) e cobertura de madrugada. CEO e radiologista e vai testar tecnicamente. A aquisicao da Beerads e de 2024 — nao usar como gancho.',
    sinais: [
      { descricao: 'Meta declarada de +55% de receita em 2026, com estrategia de M&A', data: '2026-05-15', fonteUrl: 'https://www.otempo.com.br/minas-sa/2026/5/15/vx-medical-estima-faturar-r-70-milhoes-com-avanco-da-telerradiologia' },
      { descricao: 'Lancamento de ultrassom com IA — novo produto, novo volume', data: '2026-04-28', fonteUrl: 'https://saudedigitalnews.com.br/28/04/2026/vx-medical-lanca-ultrassom-com-ia/' },
    ],
    decisores: [
      { nomeCompleto: 'André Morganti', cargo: 'Fundador e CEO (médico radiologista)', area: 'executivo_ceo', senioridade: 'c_level', fonteUrl: 'https://www.otempo.com.br/minas-sa/2026/5/15/vx-medical-estima-faturar-r-70-milhoes-com-avanco-da-telerradiologia', dataDaEvidencia: '2026-05-15', statusAtual: 'confirmado_atual', confianca: 'alta' },
      { nomeCompleto: 'Frederico Braga', cargo: 'Cofundador', area: 'executivo_ceo', senioridade: 'c_level', fonteUrl: 'https://diariodocomercio.com.br/negocios/vx-medical-innovation-acelera-laudos-democratiza-radiologia/', dataDaEvidencia: 'sem_data', statusAtual: 'provavel_atual', confianca: 'media' },
    ],
  },
  {
    nome: 'Salú',
    site: 'https://salu.com.br',
    cidade: 'São Paulo',
    uf: 'SP',
    segmento: 'Healthtech de SST / medicina ocupacional',
    tier: 2,
    score: 88,
    confianca: 'alta',
    vagas: 0,
    porqueClaves:
      'O produto vendido E o ato medico ocupacional: a necessidade de medico do trabalho e definicional, nao inferida. Cada contrato corporativo novo vira demanda direta por corpo clinico.',
    dor: '800+ clientes em todos os estados, 1 milhao+ de agendamentos ocupacionais, R$ 76,8 mi de receita liquida em 2025, CAGR de 115,5%.',
    gancho:
      'A Senior nao pagou R$ 318,7 milhoes pela plataforma — pagou pela capacidade de a Salu executar rotina ocupacional na base inteira dela. E com a NR-1 psicossocial valendo desde 26 de maio, a exigencia sobre medico do trabalho subiu junto. A pergunta e se o funil de medicos escala no mesmo ritmo que o comercial.',
    proximoPasso:
      'Mirar o modelo in-company / clinica propria operada pela Salu — boa parte da operacao roda sobre rede credenciada de terceiros e o pitch erra o alvo se nao separar isso.',
    observacoes:
      'Empresa recem-adquirida: decisao de fornecedor pode congelar durante a integracao — mas e quando metas agressivas aparecem. Sergio Cagno aparece como diretor medico em fonte de ~2022 (aporte SoftBank): NAO usar sem checar o LinkedIn antes.',
    sinais: [
      { descricao: 'Senior Sistemas compra a Salú por R$ 318,7 milhões — maior aquisição da história da compradora', data: '2026-06', fonteUrl: 'https://braziljournal.com/senior-sistemas-compra-a-healthtech-salu-por-r-319-milhoes/' },
      { descricao: 'NR-1 passa a exigir gestão de riscos psicossociais no PGR de toda empresa com CLT', data: '2026-05-26', fonteUrl: 'https://www.socialhub.pro/blog/nr1-saude-mental-ocupacional-2026-clinica-medicina-trabalho-2/' },
    ],
    decisores: [
      { nomeCompleto: 'René Neme', cargo: 'Fundador e CEO — permanece à frente da operação', area: 'executivo_ceo', senioridade: 'c_level', fonteUrl: 'https://braziljournal.com/senior-sistemas-compra-a-healthtech-salu-por-r-319-milhoes/', dataDaEvidencia: '2026-06', statusAtual: 'confirmado_atual', confianca: 'alta' },
    ],
  },
  {
    nome: 'MedSênior',
    site: 'https://medsenior.com.br',
    cidade: 'Vitória',
    uf: 'ES',
    segmento: 'Operadora verticalizada 49+',
    tier: 1,
    score: 84,
    confianca: 'media',
    vagas: 150,
    porqueClaves:
      'Hospital de medio porte inaugurando em Brasilia no fim de agosto/2026 e 150+ vagas abertas desde junho. Janela curta.',
    dor: '150+ vagas em Brasília (unidade do SIG virando hospital, R$ 24 mi), 110+ no Rio (Barra, R$ 20 mi+), 400+ no país. Presente em 7 estados + DF.',
    gancho:
      'Voces tem inauguracao do hospital do SIG marcada para o fim de agosto e 150 vagas abertas em Brasilia desde junho. A parte assistencial e administrativa a Gupy resolve — queria entender como esta o corpo clinico, que e o que costuma travar abertura.',
    proximoPasso:
      'VALIDAR NA LIGACAO se ha demanda medica. Nao afirmar que existe.',
    observacoes:
      'ATENCAO — BURACO NA EVIDENCIA, verificado em duas buscas independentes: as listas de cargos divulgadas citam tecnico de enfermagem, enfermeiro, fisio, nutricionista, psicologo, maqueiro e faturista; MEDICO nao aparece em nenhuma. A necessidade de corpo clinico e inferencia forte (nao se abre hospital sem medico), nao evidencia. Abrir com "vi que voces precisam de medicos" e chutar. Decisores nao confirmados: dois nomes apareceram na busca sem fonte primaria limpa e NAO devem ser usados.',
    sinais: [
      { descricao: '150+ vagas em Brasília com a unidade do SIG virando hospital de médio porte; inauguração prevista para o fim de agosto', data: '2026-06-10', fonteUrl: 'https://saudedigitalnews.com.br/10/06/2026/medsenior-abre-mais-de-150-vagas-em-brasilia-com-expansao-de-unidade-hospitalar/' },
      { descricao: '110+ vagas no Rio com ampliação da unidade da Barra da Tijuca', data: '2026', fonteUrl: 'https://medsenior.com.br/noticia/medsenior-abre-mais-de-110-vagas-no-rio-de-janeiro-com-ampliacao-de-unidade-na-barra-da-tijuca/' },
    ],
    decisores: [],
  },
  {
    nome: 'Grupo Opty',
    site: 'https://opty.com.br',
    cidade: 'São Paulo',
    uf: 'SP',
    segmento: 'Plataforma de saúde ocular',
    tier: 1,
    score: 80,
    confianca: 'media',
    vagas: 0,
    porqueClaves:
      'Aporte de R$ 530 milhoes da chinesa Aier com mandato explicito de consolidar oftalmologia no Brasil. Cada clinica integrada vira escala de retina, glaucoma e cornea para preencher.',
    dor: '81 centros em 8 estados, ~2.700 colaboradores. (O site institucional declara 26 marcas e 1.350 oftalmologistas; a imprensa fala em 880 médicos — divergência entre fontes, não resolvida.)',
    gancho:
      'Com o cheque de R$ 530 milhoes da Aier e o mandato de consolidar oftalmologia no Brasil, cada clinica integrada vira uma escala de retina e glaucoma para preencher em semanas, nao em meses. Foi esse problema que resolvemos na DaVita: 195 profissionais em menos de 30 dias, multiunidade.',
    proximoPasso:
      'Mapear Diretor Medico e Head de Gente no LinkedIn antes de abordar — so o CEO esta confirmado.',
    observacoes:
      'O Opty cresce comprando clinica com medico-fundador dentro: parte da necessidade e resolvida por M&A, nao por headhunting. Posicionar a Claves na reposicao e staffing das unidades ja compradas. Com controlador chines recem-chegado, decisao de fornecedor pode congelar 1-2 trimestres. Publicam edital de residencia medica — e formacao, nao licitacao; nao elimina.',
    sinais: [
      { descricao: 'Aier Eye Hospital Group injeta R$ 530 milhões por 35% e vira maior acionista; recursos para expansão e consolidação', data: '2026-06', fonteUrl: 'https://braziljournal.com/exclusivo-gigante-chinesa-da-oftalmologia-compra-35-da-opty-do-patria/' },
      { descricao: 'Grupo abre posição nova de Diretor Regional para o Rio de Janeiro', data: '2026', fonteUrl: 'https://www.saudebusiness.com/mercado/grupo-opty-abre-nova-posicao-e-contrata-diretor-regional-para-o-rio-de-janeiro' },
    ],
    decisores: [
      { nomeCompleto: 'Nelson Pestana', cargo: 'CEO — segue no comando após a entrada da Aier', area: 'executivo_ceo', senioridade: 'c_level', fonteUrl: 'https://braziljournal.com/exclusivo-gigante-chinesa-da-oftalmologia-compra-35-da-opty-do-patria/', dataDaEvidencia: '2026-06', statusAtual: 'confirmado_atual', confianca: 'alta' },
    ],
  },
  {
    nome: 'Grupo MedNet',
    site: 'https://grupomednet.com.br',
    cidade: 'Americana',
    uf: 'SP',
    segmento: 'Rede de medicina e segurança do trabalho (franquia)',
    tier: 3,
    score: 71,
    confianca: 'media',
    vagas: 0,
    porqueClaves:
      'Meta publica de sair de 65 para 200+ unidades em dois anos com a entrada da SMZTO. Cada unidade nova exige medico do trabalho responsavel antes de abrir.',
    dor: '65 unidades em 11 estados, 3.000+ clínicas credenciadas, ~20 mil empresas atendidas, R$ 150 mi de faturamento.',
    gancho:
      'Voces assumiram publicamente ir de 65 para 200 unidades em dois anos com a entrada da SMZTO. Cada unidade nova precisa de medico do trabalho responsavel antes de abrir a porta — e a NR-1 psicossocial acabou de aumentar a exigencia tecnica desse profissional. Faz sentido conversar sobre um fornecedor homologado de recrutamento medico para a rede inteira, em vez de cada franqueado se virar sozinho?',
    proximoPasso:
      'Abordar a FRANQUEADORA com proposta de fornecedor homologado da rede. Nunca o franqueado.',
    observacoes:
      'RISCO ESTRUTURAL: e franquia. Quem contrata o medico e o franqueado, nao a franqueadora. So faz sentido como acordo de fornecedor homologado para a rede. Vender unidade a unidade da ticket baixo e cai direto na anti-persona de clinica pequena. Franqueado tem investimento inicial de ~R$ 250 mil e margem de 20-25%: sensivel a preco. Ancoragem se faz com a franqueadora.',
    sinais: [
      { descricao: 'Grupo SMZTO entra com 10% e a rede assume meta de triplicar: de 65 para 200+ unidades em dois anos', data: '2026-05-22', fonteUrl: 'https://exame.com/negocios/smzto-aposta-em-rede-de-saude-do-trabalho-com-faturamento-de-r-150-mi-e-mira-triplicar-operacao/' },
    ],
    decisores: [
      { nomeCompleto: 'Paulo César Barbudo', cargo: 'Cofundador (médico)', area: 'executivo_ceo', senioridade: 'c_level', fonteUrl: 'https://exame.com/negocios/smzto-aposta-em-rede-de-saude-do-trabalho-com-faturamento-de-r-150-mi-e-mira-triplicar-operacao/', dataDaEvidencia: '2026-05-22', statusAtual: 'confirmado_atual', confianca: 'alta' },
      { nomeCompleto: 'Orjana Barbudo', cargo: 'Cofundadora (médica)', area: 'executivo_ceo', senioridade: 'c_level', fonteUrl: 'https://exame.com/negocios/smzto-aposta-em-rede-de-saude-do-trabalho-com-faturamento-de-r-150-mi-e-mira-triplicar-operacao/', dataDaEvidencia: '2026-05-22', statusAtual: 'confirmado_atual', confianca: 'alta' },
    ],
  },
  {
    nome: 'Oncoclínicas&Co',
    site: 'https://grupooncoclinicas.com',
    cidade: 'São Paulo',
    uf: 'SP',
    segmento: 'Oncologia',
    tier: 4,
    score: 45,
    confianca: 'baixa',
    vagas: 0,
    porqueClaves:
      'REBAIXADO. Plano de novos centros (Cancer Center Goiania: R$ 500 mi, 400 leitos, UTI e TMO), mas a evidencia contradiz a tese.',
    dor: 'Planos de novos centros em Goiânia, Curitiba, Vitória, Fortaleza, Aracaju e Manaus.',
    gancho:
      'O Cancer Center de Goiania sao 400 leitos, UTI e unidade de TMO — isso e um corpo clinico oncologico inteiro montado do zero, numa praca onde o pool de oncologista e hematologista e raso. Quem esta tocando o staffing medico dessa abertura?',
    proximoPasso:
      'NAO ABORDAR AINDA. Abrir vagas.grupooncoclinicas.com e conferir se ha volume medico real. So subir na lista se houver.',
    observacoes:
      'Snapshot de vagas mostrava 4 vagas abertas e NENHUMA medica (atendimento, enfermagem, faturamento), contradizendo a tese. As materias de expansao sao de fim de 2025/inicio de 2026, fora da janela de 90 dias. Grupo de capital aberto: ciclo de compras longo, RH robusto, provavel fornecedor incumbente.',
    sinais: [
      { descricao: 'Cancer Center Goiânia — investimento estimado de R$ 500 mi, 400 leitos, UTI e unidade de TMO', data: '2026', fonteUrl: 'https://opopular.com.br/economia/oncoclinicas-vai-investir-r-145-milh-es-em-goiania-1.2612473' },
    ],
    decisores: [],
  },
];

function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function dominioDe(site) {
  try {
    return new URL(site).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function principal() {
  const args = lerArgumentos(process.argv.slice(2));
  const emailDono = String(args.dono || '').trim().toLowerCase();

  if (!emailDono) {
    console.error(
      'Informe de quem sao os leads:\n' +
        '  node scripts/importar-prospeccao.js --dono sdr@claves.com.br\n'
    );
    process.exitCode = 1;
    return;
  }

  const dados = db.estado();
  const dono = dados.usuarios.find((u) => u.email === emailDono);
  if (!dono) {
    console.error(`Usuario ${emailDono} nao encontrado. Cadastre antes com criar-usuario.`);
    process.exitCode = 1;
    return;
  }

  const agora = new Date().toISOString();
  let criados = 0;
  let atualizados = 0;

  for (const entrada of LEADS) {
    const existente = dados.leads.find((l) => l.empresa?.nome === entrada.nome);

    const corpo = {
      empresa: {
        nome: entrada.nome,
        site: entrada.site,
        dominio: dominioDe(entrada.site),
        cidade: entrada.cidade,
        uf: entrada.uf,
        segmento: entrada.segmento,
        abrangencia: 'nacional',
        porteEstimado: 'medio_grande',
      },
      tier: entrada.tier,
      porqueClaves: entrada.porqueClaves,
      dorIdentificada: entrada.dor,
      sinaisDeCompra: entrada.sinais.map((s) => ({ ...s })),
      vagasAbertas: [],
      volumeEstimadoVagas: entrada.vagas,
      antiPersona: { atingido: false, codigos: [], justificativa: null },
      score: entrada.score,
      confianca: entrada.confianca,
      ganchoAbordagem: entrada.gancho,
      proximoPasso: entrada.proximoPasso,
      observacoes: entrada.observacoes,
      fontes: entrada.sinais.map((s) => ({ url: s.fonteUrl, titulo: s.descricao })),
      atualizadoEm: agora,
      origem: `varredura-publica-${HOJE}`,
    };

    let lead;
    if (existente) {
      Object.assign(existente, corpo);
      lead = existente;
      dados.contatos = dados.contatos.filter((c) => c.leadId !== lead.id);
      atualizados += 1;
    } else {
      lead = {
        id: novoId('lead'),
        criadoEm: agora,
        status: 'novo',
        dono: dono.id,
        notas: [],
        ...corpo,
      };
      dados.leads.push(lead);
      criados += 1;
    }

    for (const decisor of entrada.decisores) {
      dados.contatos.push({
        id: novoId('ctt'),
        leadId: lead.id,
        ...decisor,
        // Nenhum e-mail publico foi encontrado na varredura. O CRM nao deduz
        // endereco, entao o envio so fica disponivel depois que alguem
        // preencher isto com um contato realmente publicado.
        emailPublico: null,
        telefonePublico: null,
        linkedinUrl: null,
        trechoEvidencia: null,
        criadoEm: agora,
        origem: 'varredura-publica',
      });
    }
  }

  await db.salvar();

  console.log(
    `\n${criados} lead(s) criado(s) e ${atualizados} atualizado(s) no kanban de ${dono.nome} (${dono.email}).\n` +
      'Nenhum decisor tem e-mail: a varredura nao achou endereco publico e o sistema nao deduz.\n' +
      'Antes de ligar, leia as observacoes de MedSenior (dor medica nao comprovada),\n' +
      'MedNet (e franquia: abordar a franqueadora) e Oncoclinicas (revalidar antes).\n'
  );
}

principal();
