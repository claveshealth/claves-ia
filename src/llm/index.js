'use strict';

/**
 * Registro de provedores de LLM e cofre das credenciais.
 *
 * Regras de seguranca desta camada:
 *  - a chave de API e cifrada com AES-256-GCM antes de tocar o disco;
 *  - o AAD amarra o texto cifrado ao id do registro, entao um blob nao pode
 *    ser copiado de um provedor para outro;
 *  - nenhuma rota jamais devolve a chave em texto puro: so a mascara.
 */

const anthropic = require('./anthropic');
const openai = require('./openai');
const google = require('./google');
const { cifrar, decifrar, id: novoId, mascarar } = require('../security/crypto');
const { validarUrlExterna } = require('../security/ssrf');
const db = require('../store/db');

const PROVEDORES = { anthropic, openai, google };

function listarProvedores() {
  return Object.values(PROVEDORES).map((p) => ({
    id: p.id,
    nome: p.nome,
    suportaBuscaWebNativa: p.suportaBuscaWebNativa,
    baseUrlPadrao: p.baseUrlPadrao || null,
    modelosSugeridos: p.modelosSugeridos,
  }));
}

function adaptador(provedorId) {
  const encontrado = PROVEDORES[provedorId];
  if (!encontrado) {
    const erro = new Error(`Provedor de LLM desconhecido: ${provedorId}`);
    erro.status = 400;
    throw erro;
  }
  return encontrado;
}

function contextoCripto(registroId) {
  return `llm:credencial:${registroId}`;
}

/** Versao publica de um registro — sem segredo. */
function publico(registro, ativoId) {
  return {
    id: registro.id,
    provedor: registro.provedor,
    nomeProvedor: PROVEDORES[registro.provedor]?.nome || registro.provedor,
    apelido: registro.apelido,
    modelo: registro.modelo,
    baseUrl: registro.baseUrl || null,
    chaveMascarada: registro.chaveMascarada,
    suportaBuscaWebNativa: PROVEDORES[registro.provedor]?.suportaBuscaWebNativa ?? false,
    criadoEm: registro.criadoEm,
    ultimoTesteEm: registro.ultimoTesteEm || null,
    ultimoTesteOk: registro.ultimoTesteOk ?? null,
    ativo: registro.id === ativoId,
  };
}

function listarCredenciais() {
  const { llm } = db.estado().configuracoes;
  return llm.provedores.map((r) => publico(r, llm.provedorAtivoId));
}

async function salvarCredencial({ provedor, apelido, modelo, baseUrl, apiKey }) {
  const adapt = adaptador(provedor);

  if (!apiKey || String(apiKey).trim().length < 8) {
    const erro = new Error('Informe uma chave de API valida.');
    erro.status = 400;
    throw erro;
  }
  if (!modelo) {
    const erro = new Error('Informe o modelo.');
    erro.status = 400;
    throw erro;
  }

  let baseFinal = String(baseUrl || '').trim() || null;
  if (baseFinal) {
    // Base URL customizada e entrada do usuario: precisa passar pelo SSRF.
    await validarUrlExterna(baseFinal);
    baseFinal = baseFinal.replace(/\/+$/, '');
  }

  const registroId = novoId('llm');
  const registro = {
    id: registroId,
    provedor: adapt.id,
    apelido: String(apelido || adapt.nome).slice(0, 80),
    modelo: String(modelo).slice(0, 120),
    baseUrl: baseFinal,
    chaveCifrada: cifrar(String(apiKey).trim(), contextoCripto(registroId)),
    chaveMascarada: mascarar(String(apiKey).trim()),
    criadoEm: new Date().toISOString(),
    ultimoTesteEm: null,
    ultimoTesteOk: null,
  };

  const dados = db.estado();
  dados.configuracoes.llm.provedores.push(registro);
  if (!dados.configuracoes.llm.provedorAtivoId) {
    dados.configuracoes.llm.provedorAtivoId = registro.id;
  }
  await db.salvar();

  return publico(registro, dados.configuracoes.llm.provedorAtivoId);
}

async function removerCredencial(registroId) {
  const dados = db.estado();
  const { llm } = dados.configuracoes;
  const antes = llm.provedores.length;
  llm.provedores = llm.provedores.filter((r) => r.id !== registroId);
  if (llm.provedores.length === antes) {
    const erro = new Error('Credencial nao encontrada.');
    erro.status = 404;
    throw erro;
  }
  if (llm.provedorAtivoId === registroId) {
    llm.provedorAtivoId = llm.provedores[0]?.id || null;
  }
  await db.salvar();
}

async function definirAtiva(registroId) {
  const dados = db.estado();
  const existe = dados.configuracoes.llm.provedores.some((r) => r.id === registroId);
  if (!existe) {
    const erro = new Error('Credencial nao encontrada.');
    erro.status = 404;
    throw erro;
  }
  dados.configuracoes.llm.provedorAtivoId = registroId;
  await db.salvar();
}

/** Resolve a credencial ativa (ou uma especifica) ja decifrada. Uso interno. */
function resolverCredencial(registroId = null) {
  const { llm } = db.estado().configuracoes;
  const alvo = registroId || llm.provedorAtivoId;
  const registro = llm.provedores.find((r) => r.id === alvo);
  if (!registro) {
    const erro = new Error(
      'Nenhuma credencial de LLM configurada. Va em Configuracoes e cadastre uma chave de API.'
    );
    erro.status = 428;
    throw erro;
  }

  let apiKey;
  try {
    apiKey = decifrar(registro.chaveCifrada, contextoCripto(registro.id));
  } catch {
    const erro = new Error(
      `Nao foi possivel decifrar a chave "${registro.apelido}". A APP_MASTER_KEY mudou desde que ela foi salva. Cadastre a chave novamente.`
    );
    erro.status = 409;
    throw erro;
  }

  return {
    registro,
    adaptador: adaptador(registro.provedor),
    apiKey,
    modelo: registro.modelo,
    baseUrl: registro.baseUrl,
  };
}

async function testarCredencial(registroId) {
  const { registro, adaptador: adapt, apiKey, modelo, baseUrl } = resolverCredencial(registroId);
  const dados = db.estado();
  const alvo = dados.configuracoes.llm.provedores.find((r) => r.id === registro.id);

  try {
    const resultado = await adapt.testar({ apiKey, baseUrl, modelo });
    if (alvo) {
      alvo.ultimoTesteEm = new Date().toISOString();
      alvo.ultimoTesteOk = true;
    }
    await db.salvar();
    return resultado;
  } catch (erro) {
    if (alvo) {
      alvo.ultimoTesteEm = new Date().toISOString();
      alvo.ultimoTesteOk = false;
    }
    await db.salvar();
    throw new Error(`Falha no teste: ${erro.message}`);
  }
}

module.exports = {
  PROVEDORES,
  listarProvedores,
  listarCredenciais,
  salvarCredencial,
  removerCredencial,
  definirAtiva,
  resolverCredencial,
  testarCredencial,
};
