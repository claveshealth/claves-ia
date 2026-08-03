'use strict';

/**
 * Teste de integracao do pipeline agentico, com o LLM simulado.
 *
 * Isto cobre o caminho que so acontece de verdade em producao: a pesquisa roda,
 * o dossie e persistido, o lead nasce no kanban de QUEM disparou e o decisor
 * vira contato. Sem este teste, o fluxo principal do produto so seria exercido
 * quando alguem gastasse credito de API — e um bug de posse de lead so
 * apareceria em uso real.
 *
 * O adaptador falso devolve chamadas de ferramenta na mesma forma que os
 * adaptadores reais (`blocos` com `tipo: 'ferramenta'`), entao o orquestrador
 * roda sem saber que o modelo nao existe.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// O banco resolve o caminho a partir de config, que le o ambiente no require.
// Por isso o diretorio temporario precisa existir ANTES de carregar os modulos.
const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'claves-teste-'));
process.env.APP_MASTER_KEY = require('node:crypto').randomBytes(32).toString('hex');

const config = require('../src/config');
config.diretorioDados = dirTemp;
config.arquivoDados = path.join(dirTemp, 'claves.json');

const db = require('../src/store/db');
const llm = require('../src/llm');
const orquestrador = require('../src/agentes/orquestrador');
const { id: novoId, hashSenha } = require('../src/security/crypto');

/** Constroi um adaptador que devolve as respostas na ordem programada. */
function adaptadorFalso(roteiro) {
  let chamada = 0;
  return {
    // Simula um provedor com busca server-side (Anthropic): sem isso o
    // orquestrador exige chave de busca externa antes de comecar.
    suportaBuscaWebNativa: true,
    async conversar() {
      const passo = roteiro[Math.min(chamada, roteiro.length - 1)];
      chamada += 1;
      return {
        blocos: passo,
        uso: { entrada: 10, saida: 10 },
        paradaPor: passo.some((b) => b.tipo === 'ferramenta') ? 'tool_use' : 'end_turn',
      };
    },
  };
}

function ferramenta(nome, entrada) {
  return { tipo: 'ferramenta', id: novoId('tool'), nome, entrada };
}

function prepararUsuario(papel = 'sdr') {
  const dados = db.estado();
  const usuario = {
    id: novoId('usr'),
    email: `${papel}@teste.local`,
    nome: `Pessoa ${papel}`,
    papel,
    ativo: true,
    senhaHash: hashSenha('senha-de-teste-longa'),
    criadoEm: new Date().toISOString(),
  };
  dados.usuarios.push(usuario);
  return usuario;
}

test.after(() => fs.rmSync(dirTemp, { recursive: true, force: true }));

test('a pesquisa grava o lead no kanban de quem disparou', async () => {
  const sdr = prepararUsuario('sdr');

  // Fase 1 registra uma candidata; fase 2 devolve o dossie dela.
  const roteiro = [
    [ferramenta('registrar_candidata', {
      nome: 'VX Medical Innovation',
      tierProvavel: 2,
      motivo: 'Telerradiologia com escassez declarada de radiologistas.',
      site: 'https://vxmedical.com.br',
      cidade: 'Belo Horizonte',
      uf: 'MG',
    })],
    [{ tipo: 'texto', texto: 'Descoberta concluida.' }],
    [ferramenta('registrar_lead_qualificado', {
      empresa: {
        nome: 'VX Medical Innovation',
        site: 'https://vxmedical.com.br',
        cidade: 'Belo Horizonte',
        uf: 'MG',
        segmento: 'Telerradiologia',
      },
      tier: 2,
      porqueClaves: 'A propria empresa declara que a escassez de radiologista e o gargalo.',
      score: 92,
      confianca: 'alta',
      ganchoAbordagem: 'Voces disseram em maio que o problema e escala, nao falta pontual.',
      volumeEstimadoVagas: 12,
      antiPersona: { atingido: false, codigos: [] },
      decisores: [{
        nomeCompleto: 'Andre Morganti',
        cargo: 'CEO',
        fonteUrl: 'https://exemplo.com/noticia',
        statusAtual: 'confirmado_atual',
        confianca: 'alta',
      }],
    })],
    [{ tipo: 'texto', texto: 'Aprofundamento concluido.' }],
  ];

  const original = llm.resolverCredencial;
  llm.resolverCredencial = () => ({
    registro: { id: 'falso', apelido: 'simulado' },
    adaptador: adaptadorFalso(roteiro),
    apiKey: 'falsa',
    modelo: 'modelo-simulado',
    baseUrl: null,
  });

  try {
    await orquestrador.executarPesquisa({
      usuarioId: sdr.id,
      tiers: [2],
      regiao: 'Minas Gerais',
      segmentoLivre: '',
      profundidade: 'rapida',
      credencialId: null,
      emitir: () => {},
      signal: new AbortController().signal,
    });
  } finally {
    llm.resolverCredencial = original;
  }

  const dados = db.estado();
  const lead = dados.leads.find((l) => l.empresa.nome === 'VX Medical Innovation');

  assert.ok(lead, 'o lead precisa ter sido persistido');
  assert.equal(lead.dono, sdr.id, 'o lead tem de nascer no kanban de quem disparou a pesquisa');
  assert.equal(lead.status, 'novo');
  assert.equal(lead.tier, 2);
  assert.equal(lead.score, 92);

  const contatos = dados.contatos.filter((c) => c.leadId === lead.id);
  assert.equal(contatos.length, 1, 'o decisor confirmado vira contato');
  assert.equal(contatos[0].nomeCompleto, 'Andre Morganti');
});

test('quem bate na anti-persona entra descartado e sem contato', async () => {
  const sdr = prepararUsuario('sdr');

  const roteiro = [
    [ferramenta('registrar_candidata', {
      nome: 'Instituto Exemplo OS',
      tierProvavel: 1,
      motivo: 'Gere hospital publico.',
    })],
    [{ tipo: 'texto', texto: 'ok' }],
    [ferramenta('registrar_lead_qualificado', {
      empresa: { nome: 'Instituto Exemplo OS' },
      tier: 1,
      porqueClaves: 'Contrata por edital.',
      score: 10,
      confianca: 'alta',
      antiPersona: {
        atingido: true,
        codigos: ['contrata_por_edital_ou_licitacao'],
        justificativa: 'Processo seletivo publico com taxa de inscricao.',
      },
      decisores: [{
        nomeCompleto: 'Alguem Qualquer',
        cargo: 'Diretor',
        fonteUrl: 'https://exemplo.com',
        statusAtual: 'confirmado_atual',
        confianca: 'alta',
      }],
    })],
    [{ tipo: 'texto', texto: 'ok' }],
  ];

  const original = llm.resolverCredencial;
  llm.resolverCredencial = () => ({
    registro: { id: 'falso', apelido: 'simulado' },
    adaptador: adaptadorFalso(roteiro),
    apiKey: 'falsa',
    modelo: 'modelo-simulado',
    baseUrl: null,
  });

  try {
    await orquestrador.executarPesquisa({
      usuarioId: sdr.id,
      tiers: [1],
      regiao: 'Brasil',
      segmentoLivre: '',
      profundidade: 'rapida',
      credencialId: null,
      emitir: () => {},
      signal: new AbortController().signal,
    });
  } finally {
    llm.resolverCredencial = original;
  }

  const lead = db.estado().leads.find((l) => l.empresa.nome === 'Instituto Exemplo OS');
  assert.ok(lead, 'o lead precisa ser gravado, para o SDR nao reencontra-lo em outra pesquisa');
  assert.equal(lead.status, 'descartado', 'anti-persona nao pode entrar no funil de trabalho');
  assert.equal(lead.antiPersona.atingido, true);
  assert.deepEqual(lead.antiPersona.codigos, ['contrata_por_edital_ou_licitacao']);
});

test('decisor que saiu da empresa nao vira contato', async () => {
  const sdr = prepararUsuario('sdr');

  const roteiro = [
    [ferramenta('registrar_candidata', { nome: 'Empresa Com Ex', tierProvavel: 3, motivo: 'x' })],
    [{ tipo: 'texto', texto: 'ok' }],
    [ferramenta('registrar_lead_qualificado', {
      empresa: { nome: 'Empresa Com Ex' },
      tier: 3,
      porqueClaves: 'y',
      score: 60,
      confianca: 'media',
      antiPersona: { atingido: false, codigos: [] },
      decisores: [
        {
          nomeCompleto: 'Ja Saiu',
          cargo: 'Ex-Diretor',
          fonteUrl: 'https://exemplo.com',
          statusAtual: 'saiu_da_empresa',
          confianca: 'alta',
        },
        {
          nomeCompleto: 'Continua Aqui',
          cargo: 'Diretora Medica',
          fonteUrl: 'https://exemplo.com',
          statusAtual: 'confirmado_atual',
          confianca: 'alta',
        },
      ],
    })],
    [{ tipo: 'texto', texto: 'ok' }],
  ];

  const original = llm.resolverCredencial;
  llm.resolverCredencial = () => ({
    registro: { id: 'falso', apelido: 'simulado' },
    adaptador: adaptadorFalso(roteiro),
    apiKey: 'falsa',
    modelo: 'modelo-simulado',
    baseUrl: null,
  });

  try {
    await orquestrador.executarPesquisa({
      usuarioId: sdr.id,
      tiers: [3],
      regiao: 'Brasil',
      segmentoLivre: '',
      profundidade: 'rapida',
      credencialId: null,
      emitir: () => {},
      signal: new AbortController().signal,
    });
  } finally {
    llm.resolverCredencial = original;
  }

  const dados = db.estado();
  const lead = dados.leads.find((l) => l.empresa.nome === 'Empresa Com Ex');
  const contatos = dados.contatos.filter((c) => c.leadId === lead.id);

  assert.equal(contatos.length, 1, 'so o decisor atual entra');
  assert.equal(contatos[0].nomeCompleto, 'Continua Aqui');
});
