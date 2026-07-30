'use strict';

/**
 * Testes das regras que, se quebrarem em silencio, estragam o trabalho:
 * o filtro que decide quem vira lead, a autorizacao por papel, o parse de
 * perfil do LinkedIn e a montagem da mensagem de e-mail.
 *
 * Roda com o runner nativo do Node (`npm test`) — sem dependencia de teste.
 */

const test = require('node:test');
const assert = require('node:assert');

const icp = require('../src/agentes/icp');
const papeis = require('../src/security/papeis');
const linkedin = require('../src/fontes/linkedin');
const smtp = require('../src/lib/smtp');

// ------------------------------------------------------------------- ICP

test('o briefing abre pelo filtro zero, antes de qualquer tier', () => {
  const briefing = icp.briefingCompleto();
  assert.ok(briefing.startsWith('# FILTRO ZERO'), 'o filtro zero precisa vir primeiro');
  assert.ok(
    briefing.indexOf('FILTRO ZERO') < briefing.indexOf('TIER 1'),
    'o filtro nao pode aparecer depois dos tiers'
  );
});

test('a regra eliminatoria cita edital, concurso, licitacao e OS', () => {
  const regra = icp.REGRA_CONTRATACAO_DIRETA.toLowerCase();
  for (const termo of ['edital', 'concurso', 'licitacao', 'processo seletivo publico', 'os/oss']) {
    assert.ok(regra.includes(termo), `a regra precisa citar "${termo}"`);
  }
});

test('existe anti-persona para quem contrata por edital', () => {
  const codigos = icp.ANTI_PERSONA.map((a) => a.codigo);
  assert.ok(codigos.includes('contrata_por_edital_ou_licitacao'));
  // A anti-persona antiga era restrita a orgao publico e deixava OS privada
  // passar — foi ela que aprovou o ISGH. Nao pode voltar.
  assert.ok(!codigos.includes('orgao_publico_concurso'), 'a regra antiga nao pode ressuscitar');
});

test('nenhum tier oferece licitacao como sinal de compra', () => {
  for (const tier of Object.values(icp.TIERS)) {
    for (const sinal of tier.sinaisDeCompra) {
      assert.ok(
        !/licita/i.test(sinal),
        `Tier ${tier.id} ainda trata licitacao como sinal de compra: "${sinal}"`
      );
    }
  }
});

test('o PNCP nao volta como lugar de cacar lead', () => {
  for (const tier of Object.values(icp.TIERS)) {
    for (const lugar of tier.ondeCacar) {
      assert.ok(!/pncp/i.test(lugar), `Tier ${tier.id} ainda aponta para o PNCP`);
    }
  }
});

// --------------------------------------------------------------- papeis

test('SDR ve apenas os proprios leads; gestor e admin veem a equipe', () => {
  assert.equal(papeis.podeVerTodosLeads({ papel: 'sdr' }), false);
  assert.equal(papeis.podeVerTodosLeads({ papel: 'gestor' }), true);
  assert.equal(papeis.podeVerTodosLeads({ papel: 'admin' }), true);
});

test('gestor cadastra apenas SDR e nao promove ninguem', () => {
  assert.deepEqual(papeis.papeisQuePodeAtribuir({ papel: 'gestor' }), ['sdr']);
  assert.equal(papeis.podeAtribuirPapel({ papel: 'gestor' }, 'admin'), false);
  assert.equal(papeis.podeAtribuirPapel({ papel: 'gestor' }, 'gestor'), false);
  assert.equal(papeis.podeAtribuirPapel({ papel: 'admin' }, 'gestor'), true);
});

test('SDR nao cadastra ninguem nem mexe em integracao', () => {
  assert.deepEqual(papeis.papeisQuePodeAtribuir({ papel: 'sdr' }), []);
  assert.equal(papeis.podeGerenciarUsuarios({ papel: 'sdr' }), false);
  assert.equal(papeis.podeConfigurarIntegracoes({ papel: 'gestor' }), false);
  assert.equal(papeis.podeConfigurarIntegracoes({ papel: 'admin' }), true);
});

// -------------------------------------------------------------- LinkedIn

test('extrai nome, cargo e empresa do titulo publico do perfil', () => {
  assert.deepEqual(linkedin.analisarTitulo('Andre Morganti - CEO - VX Medical | LinkedIn'), {
    nome: 'Andre Morganti',
    cargo: 'CEO',
    empresaNoTitulo: 'VX Medical',
  });
  // O LinkedIn tambem usa travessao no lugar do hifen.
  assert.deepEqual(linkedin.analisarTitulo('Nelson Pestana – Diretor – Grupo Opty | LinkedIn'), {
    nome: 'Nelson Pestana',
    cargo: 'Diretor',
    empresaNoTitulo: 'Grupo Opty',
  });
});

test('titulo de post nao e confundido com perfil', () => {
  assert.equal(linkedin.analisarTitulo('Joao Silva on LinkedIn: veja esta vaga'), null);
});

test('nome de empresa normaliza sufixo societario e acento', () => {
  assert.equal(linkedin.chaveEmpresa('Grupo Opty S.A.'), linkedin.chaveEmpresa('OPTY'));
  assert.equal(linkedin.chaveEmpresa('Salú'), 'salu');
});

test('cargo decisor pontua acima de cargo irrelevante', () => {
  assert.ok(linkedin.pontuarCargo('Diretor Médico') > linkedin.pontuarCargo('Estagiário'));
  assert.equal(linkedin.pontuarCargo(null), 0);
});

// ------------------------------------------------------------------ SMTP

test('assunto com acento sai em MIME encoded-word e ASCII passa direto', () => {
  assert.match(smtp.cabecalhoCodificado('Reposição'), /^=\?UTF-8\?B\?/);
  assert.equal(smtp.cabecalhoCodificado('Hello'), 'Hello');
});

test('CRLF em assunto ou nome nao injeta cabecalho novo', () => {
  for (const malicioso of ['oi\r\nBcc: vitima@x.com', 'oi\nBcc: vitima@x.com']) {
    const { texto } = smtp.montarMensagem({
      de: 'a@b.com',
      deNome: malicioso,
      para: 'c@d.com',
      assunto: malicioso,
      corpo: 'x',
    });
    const cabecalhos = texto.split('\r\n\r\n')[0].split('\r\n');
    assert.ok(
      !cabecalhos.some((linha) => /^bcc:/i.test(linha)),
      'CRLF em cabecalho nao pode virar linha propria'
    );
  }
});

test('valida endereco de e-mail', () => {
  assert.ok(smtp.validarEmail('contato@claves.com.br'));
  assert.ok(!smtp.validarEmail('sem-arroba'));
  assert.ok(!smtp.validarEmail('a@b'));
});
