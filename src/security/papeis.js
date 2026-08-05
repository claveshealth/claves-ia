'use strict';

/**
 * Papeis e autorizacao.
 *
 * Tres papeis, do mais para o menos privilegiado:
 *
 *   admin   — dono do sistema. Faz tudo: cria gestor e SDR, configura LLM,
 *             busca e e-mail, ve e reatribui qualquer lead.
 *   gestor  — chefe de equipe comercial. Cadastra e desativa SDR, ve o pipeline
 *             inteiro, reatribui lead entre SDRs. NAO mexe em credenciais nem
 *             em configuracao de integracao.
 *   sdr     — quem opera. Dispara pesquisa e trabalha o proprio kanban. Ve
 *             apenas os leads dos quais e dono.
 *
 * A regra central do produto: o lead encontrado numa pesquisa vai para o kanban
 * de quem apertou o botao. `podeVerTodosLeads` e o que separa "meu kanban" de
 * "pipeline da equipe".
 */

const PAPEIS = ['admin', 'gestor', 'sdr'];

const DESCRICAO = {
  admin: 'Administrador — acesso total, incluindo credenciais e integracoes.',
  gestor: 'Gestor — cadastra SDR, ve o pipeline inteiro e reatribui leads.',
  sdr: 'SDR — dispara pesquisas e trabalha o proprio kanban.',
};

function papelValido(papel) {
  return PAPEIS.includes(papel);
}

/** Gestor e admin enxergam o pipeline da equipe; SDR enxerga so o proprio. */
function podeVerTodosLeads(usuario) {
  return usuario?.papel === 'admin' || usuario?.papel === 'gestor';
}

/** Reatribuir lead entre SDRs e ato de gestao. */
function podeReatribuirLead(usuario) {
  return podeVerTodosLeads(usuario);
}

function podeGerenciarUsuarios(usuario) {
  return usuario?.papel === 'admin' || usuario?.papel === 'gestor';
}

/**
 * Quem pode criar/editar qual papel. Gestor monta o proprio time de SDR, mas
 * nao promove ninguem a gestor nem a admin — isso evita escalada de privilegio
 * por quem so deveria administrar a operacao comercial.
 */
function papeisQuePodeAtribuir(usuario) {
  if (usuario?.papel === 'admin') return [...PAPEIS];
  if (usuario?.papel === 'gestor') return ['sdr'];
  return [];
}

function podeAtribuirPapel(usuario, papelAlvo) {
  return papeisQuePodeAtribuir(usuario).includes(papelAlvo);
}

/** Somente admin toca em credencial de LLM, chave de busca e SMTP. */
function podeConfigurarIntegracoes(usuario) {
  return usuario?.papel === 'admin';
}

/**
 * Um usuario nunca pode se rebaixar, se desativar ou se excluir: isso e o que
 * impede o sistema de ficar sem nenhum admin por acidente.
 */
function eProprioUsuario(usuario, idAlvo) {
  return usuario?.id === idAlvo;
}

module.exports = {
  PAPEIS,
  DESCRICAO,
  papelValido,
  podeVerTodosLeads,
  podeReatribuirLead,
  podeGerenciarUsuarios,
  papeisQuePodeAtribuir,
  podeAtribuirPapel,
  podeConfigurarIntegracoes,
  eProprioUsuario,
};
