#!/usr/bin/env node
'use strict';

/**
 * Cria (ou redefine a senha de) um usuario do CRM.
 * Uso interativo — a senha nao aparece no historico do shell.
 */

const readline = require('node:readline');
const db = require('../src/store/db');
const { hashSenha, id: novoId } = require('../src/security/crypto');
const papeis = require('../src/security/papeis');
const config = require('../src/config');

function perguntar(rl, texto, { oculto = false } = {}) {
  return new Promise((resolve) => {
    // Sem terminal (provisionamento por pipe/script) nao ha eco para esconder,
    // e o truque de silenciar a saida trava a leitura. Cai para pergunta comum.
    if (!oculto || !process.stdin.isTTY) return rl.question(texto, resolve);

    // Modo oculto: silencia o eco do terminal enquanto digita.
    const saida = process.stdout;
    const escrever = saida.write.bind(saida);
    let silenciando = false;
    saida.write = (pedaco, ...resto) => {
      if (silenciando && typeof pedaco === 'string' && !pedaco.includes('\n')) return true;
      return escrever(pedaco, ...resto);
    };
    rl.question(texto, (resposta) => {
      saida.write = escrever;
      saida.write('\n');
      resolve(resposta);
    });
    silenciando = true;
  });
}

/**
 * Modo nao-interativo, para provisionamento scriptado:
 *
 *   CLAVES_SENHA='...' node scripts/criar-usuario.js \
 *     --email pessoa@claves.com.br --nome "Pessoa" --papel sdr
 *
 * A senha vem de variavel de ambiente, nunca de argumento: argumento aparece
 * em `ps` e no historico do shell.
 */
function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const atual = argv[i];
    if (!atual.startsWith('--')) continue;
    const chave = atual.slice(2);
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith('--')) args[chave] = true;
    else {
      args[chave] = valor;
      i += 1;
    }
  }
  return args;
}

async function modoNaoInterativo(args) {
  const email = String(args.email || '').trim().toLowerCase();
  if (!email.includes('@')) throw new Error('Informe --email valido.');

  const senha = process.env.CLAVES_SENHA || '';
  if (!senha) {
    throw new Error('Defina a senha em CLAVES_SENHA (variavel de ambiente), nao em argumento.');
  }

  const dados = db.estado();
  const existente = dados.usuarios.find((u) => u.email === email);
  const primeiroUsuario = dados.usuarios.length === 0;

  const nome = String(args.nome || '').trim() || email.split('@')[0];
  let papel = primeiroUsuario ? 'admin' : String(args.papel || 'sdr').toLowerCase();
  if (existente) papel = existente.papel || 'admin';
  if (!papeis.papelValido(papel)) {
    throw new Error(`Papel invalido: ${papel}. Use um de: ${papeis.PAPEIS.join(', ')}.`);
  }

  if (existente) {
    existente.senhaHash = hashSenha(senha);
    existente.nome = nome;
    if (existente.ativo === undefined) existente.ativo = true;
    await db.salvar();
    console.log(`Senha de ${email} redefinida (papel mantido: ${papel}).`);
    return;
  }

  dados.usuarios.push({
    id: novoId('usr'),
    email,
    nome,
    papel,
    ativo: true,
    senhaHash: hashSenha(senha),
    criadoEm: new Date().toISOString(),
    ultimoLogin: null,
  });
  await db.salvar();
  console.log(
    `Usuario ${email} criado como ${papel}.${primeiroUsuario ? ' (primeiro usuario: admin)' : ''}`
  );
}

async function principal() {
  const args = lerArgumentos(process.argv.slice(2));
  if (args.email) {
    try {
      await modoNaoInterativo(args);
    } catch (erro) {
      console.error(`Erro: ${erro.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (config.chaveMestraEfemera) {
      console.warn(
        '\nAVISO: APP_MASTER_KEY nao esta definida. Gere uma com "npm run gerar-chave"\n' +
          'antes de cadastrar chaves de API de LLM.\n'
      );
    }

    const email = (await perguntar(rl, 'E-mail: ')).trim().toLowerCase();
    if (!email.includes('@')) throw new Error('E-mail invalido.');

    const nome = (await perguntar(rl, 'Nome: ')).trim() || email.split('@')[0];

    const dados = db.estado();
    const existente = dados.usuarios.find((u) => u.email === email);
    const primeiroUsuario = dados.usuarios.length === 0;

    // O papel e perguntado, nao assumido. Antes este script criava admin em
    // qualquer caso — usa-lo para cadastrar a equipe daria acesso total a
    // credenciais para todo mundo, em silencio. O primeiro usuario continua
    // sendo admin por necessidade: alguem precisa configurar o sistema.
    let papel = 'admin';
    if (existente) {
      papel = existente.papel || 'admin';
    } else if (!primeiroUsuario) {
      const resposta = (
        await perguntar(rl, `Papel [${papeis.PAPEIS.join('/')}] (padrao: sdr): `)
      ).trim().toLowerCase();
      papel = resposta || 'sdr';
      if (!papeis.papelValido(papel)) {
        throw new Error(`Papel invalido. Use um de: ${papeis.PAPEIS.join(', ')}.`);
      }
    }

    const senha = await perguntar(rl, 'Senha (min. 12 caracteres): ', { oculto: true });
    const confirmacao = await perguntar(rl, 'Confirme a senha: ', { oculto: true });

    if (senha !== confirmacao) throw new Error('As senhas nao conferem.');

    if (existente) {
      existente.senhaHash = hashSenha(senha); // valida o tamanho minimo
      existente.nome = nome;
      if (existente.ativo === undefined) existente.ativo = true;
      await db.salvar();
      console.log(`\nSenha de ${email} redefinida (papel mantido: ${papel}).\n`);
    } else {
      dados.usuarios.push({
        id: novoId('usr'),
        email,
        nome,
        papel,
        ativo: true,
        senhaHash: hashSenha(senha),
        criadoEm: new Date().toISOString(),
        ultimoLogin: null,
      });
      await db.salvar();
      console.log(
        `\nUsuario ${email} criado como ${papel}.` +
          (primeiroUsuario ? ' (primeiro usuario do sistema: admin)' : '') +
          '\n'
      );
    }
  } catch (erro) {
    console.error(`\nErro: ${erro.message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

principal();
