'use strict';

/**
 * Testes do "esqueci minha senha".
 *
 * E codigo de seguranca: um erro aqui vira sequestro de conta. As propriedades
 * abaixo sao as que precisam valer sempre — token de uso unico, com prazo, que
 * nao fica em texto puro no banco, e uma rota publica que nao revela quais
 * e-mails tem conta.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'claves-recup-'));
process.env.APP_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const config = require('../src/config');
config.diretorioDados = dirTemp;
config.arquivoDados = path.join(dirTemp, 'claves.json');

const db = require('../src/store/db');
const auth = require('../src/rotas/auth');
const { id: novoId, hashSenha } = require('../src/security/crypto');

function novoUsuario({ ativo = true } = {}) {
  const usuario = {
    id: novoId('usr'),
    email: `${novoId('u')}@teste.local`,
    nome: 'Pessoa de Teste',
    papel: 'sdr',
    ativo,
    senhaHash: hashSenha('senha-antiga-comprida'),
    criadoEm: new Date().toISOString(),
  };
  db.estado().usuarios.push(usuario);
  return usuario;
}

test.after(() => fs.rmSync(dirTemp, { recursive: true, force: true }));

test('o token cru nunca e gravado — so o hash', () => {
  const usuario = novoUsuario();
  const token = auth.criarTokenRedefinicao(usuario);

  const serializado = JSON.stringify(usuario);
  assert.ok(!serializado.includes(token), 'o token em texto puro nao pode estar no registro');
  assert.ok(usuario.redefinicao.tokenHash, 'o hash precisa estar gravado');
  assert.notEqual(usuario.redefinicao.tokenHash, token);
});

test('token valido devolve o usuario e so funciona uma vez', () => {
  const usuario = novoUsuario();
  const token = auth.criarTokenRedefinicao(usuario);

  const primeira = auth.consumirTokenRedefinicao(token);
  assert.equal(primeira?.id, usuario.id, 'o primeiro uso precisa valer');

  const segunda = auth.consumirTokenRedefinicao(token);
  assert.equal(segunda, null, 'reusar o mesmo link nao pode funcionar');
});

test('token expirado e recusado, e some do registro', () => {
  const usuario = novoUsuario();
  const token = auth.criarTokenRedefinicao(usuario);

  // Empurra a expiracao para o passado, como se a hora tivesse passado.
  usuario.redefinicao.expiraEm = Date.now() - 1000;

  assert.equal(auth.consumirTokenRedefinicao(token), null);
  assert.equal(usuario.redefinicao, null, 'token vencido tambem precisa ser consumido');
});

test('token de conta desativada nao serve', () => {
  const usuario = novoUsuario({ ativo: false });
  const token = auth.criarTokenRedefinicao(usuario);
  assert.equal(auth.consumirTokenRedefinicao(token), null);
});

test('token inexistente ou vazio nao derruba nem acerta', () => {
  novoUsuario();
  assert.equal(auth.consumirTokenRedefinicao(''), null);
  assert.equal(auth.consumirTokenRedefinicao(null), null);
  assert.equal(auth.consumirTokenRedefinicao('a'.repeat(64)), null);
});

test('um token nao abre a conta de outra pessoa', () => {
  const alvo = novoUsuario();
  const outra = novoUsuario();
  auth.criarTokenRedefinicao(outra);
  const tokenDoAlvo = auth.criarTokenRedefinicao(alvo);

  const encontrado = auth.consumirTokenRedefinicao(tokenDoAlvo);
  assert.equal(encontrado?.id, alvo.id, 'o token tem de resolver para o dono dele');
});
