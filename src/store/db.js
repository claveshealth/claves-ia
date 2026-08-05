'use strict';

/**
 * Persistencia em arquivo JSON com escrita atomica.
 *
 * Escolha deliberada: zero dependencias nativas, backup trivial (um arquivo),
 * suficiente para a ordem de grandeza de um CRM de prospeccao (dezenas de
 * milhares de leads). Toda a leitura vem de um cache em memoria; a escrita e
 * serializada numa fila para evitar corrida entre requisicoes concorrentes.
 *
 * O arquivo contem hashes de senha e chaves de API cifradas — por isso
 * `data/` esta no .gitignore e o diretorio e criado com permissao 0700.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

const ESTADO_INICIAL = {
  versao: 3,
  usuarios: [],
  configuracoes: {
    llm: {
      provedores: [], // credenciais cifradas
      provedorAtivoId: null,
    },
    integracoes: {
      // chaves opcionais (busca web para provedores sem web search nativo)
      buscaWeb: null,
      email: null, // SMTP para envio a partir do CRM (senha cifrada)
    },
  },
  leads: [],
  contatos: [],
  atividades: [], // historico de contato por lead (e-mail enviado, ligacao, nota)
  execucoes: [], // historico das pesquisas do agente
  auditoria: [],
};

/**
 * Migracoes de esquema. Cada uma leva o banco de uma versao para a seguinte e
 * precisa ser idempotente — o boot roda todas as pendentes em ordem.
 */
function migrar(dados) {
  let mudou = false;

  if (!dados.versao || dados.versao < 3) {
    // v3 introduziu papeis (admin/gestor/sdr) e desativacao de usuario.
    for (const usuario of dados.usuarios || []) {
      if (!usuario.papel) {
        usuario.papel = 'admin';
        mudou = true;
      }
      if (usuario.ativo === undefined) {
        usuario.ativo = true;
        mudou = true;
      }
    }
    // Leads antigos podem nao ter dono; ficam sem dono e visiveis so a gestor
    // e admin, que reatribuem pela tela de pipeline.
    for (const lead of dados.leads || []) {
      if (lead.dono === undefined) {
        lead.dono = null;
        mudou = true;
      }
    }
    dados.versao = 3;
    mudou = true;
  }

  return mudou;
}

let cache = null;
let filaEscrita = Promise.resolve();

function garantirDiretorio() {
  fs.mkdirSync(config.diretorioDados, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(config.diretorioDados, 0o700);
  } catch {
    /* sistemas de arquivos sem suporte a chmod (ex.: Windows) */
  }
}

function clonarProfundo(valor) {
  return structuredClone(valor);
}

function carregar() {
  if (cache) return cache;
  garantirDiretorio();
  try {
    const bruto = fs.readFileSync(config.arquivoDados, 'utf8');
    const dados = JSON.parse(bruto);
    cache = { ...clonarProfundo(ESTADO_INICIAL), ...dados };
    // Garante que colecoes novas apareçam em bancos antigos.
    for (const [chave, valor] of Object.entries(ESTADO_INICIAL)) {
      if (cache[chave] === undefined) cache[chave] = clonarProfundo(valor);
    }
    if (!cache.configuracoes.integracoes) {
      cache.configuracoes.integracoes = clonarProfundo(ESTADO_INICIAL.configuracoes.integracoes);
    }
    if (migrar(cache)) {
      // Persiste o esquema migrado de forma sincrona: se o processo cair antes
      // da primeira escrita assincrona, o banco em disco continuaria na versao
      // antiga e a migracao rodaria de novo (e idempotente, mas evitamos).
      garantirDiretorio();
      const temporario = `${config.arquivoDados}.${process.pid}.migr.tmp`;
      fs.writeFileSync(temporario, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporario, config.arquivoDados);
    }
  } catch (erro) {
    if (erro.code !== 'ENOENT') {
      throw new Error(
        `Falha ao ler ${config.arquivoDados}: ${erro.message}. Restaure um backup ou remova o arquivo para reinicializar.`
      );
    }
    cache = clonarProfundo(ESTADO_INICIAL);
  }
  return cache;
}

/** Estado vivo (mutavel). Sempre chame salvar() apos alterar. */
function estado() {
  return carregar();
}

async function gravarNoDisco() {
  garantirDiretorio();
  const temporario = `${config.arquivoDados}.${process.pid}.tmp`;
  const conteudo = JSON.stringify(cache, null, 2);
  await fsp.writeFile(temporario, conteudo, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporario, config.arquivoDados);
  try {
    await fsp.chmod(config.arquivoDados, 0o600);
  } catch {
    /* ignorado em FS sem suporte */
  }
}

/** Enfileira uma gravacao atomica. Resolve quando o disco foi atualizado. */
function salvar() {
  carregar();
  filaEscrita = filaEscrita.then(gravarNoDisco, gravarNoDisco);
  return filaEscrita;
}

/** Aplica uma mutacao e persiste. */
async function transacao(fn) {
  const dados = carregar();
  const resultado = await fn(dados);
  await salvar();
  return resultado;
}

function registrarAuditoria(evento) {
  const dados = carregar();
  dados.auditoria.push({
    em: new Date().toISOString(),
    ...evento,
  });
  // Mantem a auditoria limitada para o arquivo nao crescer sem limite.
  if (dados.auditoria.length > 5000) {
    dados.auditoria.splice(0, dados.auditoria.length - 5000);
  }
}

module.exports = { estado, salvar, transacao, registrarAuditoria };
