#!/usr/bin/env node
'use strict';

/**
 * Cria (ou redefine a senha de) um usuario do CRM.
 * Uso interativo — a senha nao aparece no historico do shell.
 */

const readline = require('node:readline');
const db = require('../src/store/db');
const { hashSenha, id: novoId } = require('../src/security/crypto');
const config = require('../src/config');

function perguntar(rl, texto, { oculto = false } = {}) {
  return new Promise((resolve) => {
    if (!oculto) return rl.question(texto, resolve);

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

async function principal() {
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
    const senha = await perguntar(rl, 'Senha (min. 12 caracteres): ', { oculto: true });
    const confirmacao = await perguntar(rl, 'Confirme a senha: ', { oculto: true });

    if (senha !== confirmacao) throw new Error('As senhas nao conferem.');

    const dados = db.estado();
    const existente = dados.usuarios.find((u) => u.email === email);

    if (existente) {
      existente.senhaHash = hashSenha(senha); // valida o tamanho minimo
      existente.nome = nome;
      await db.salvar();
      console.log(`\nSenha de ${email} redefinida com sucesso.\n`);
    } else {
      dados.usuarios.push({
        id: novoId('usr'),
        email,
        nome,
        papel: 'admin',
        senhaHash: hashSenha(senha),
        criadoEm: new Date().toISOString(),
        ultimoLogin: null,
      });
      await db.salvar();
      console.log(`\nUsuario ${email} criado com sucesso.\n`);
    }
  } catch (erro) {
    console.error(`\nErro: ${erro.message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

principal();
