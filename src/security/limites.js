'use strict';

/**
 * Rate limiting em memoria (janela deslizante por balde).
 *
 * Cobre dois riscos distintos:
 *  - forca bruta no login (por IP e por conta);
 *  - abuso das pesquisas do agente, que gastam creditos de LLM reais.
 */

const baldes = new Map(); // chave -> { contagem, reiniciaEm }

function consumir(chave, limite, janelaMs) {
  const agora = Date.now();
  const balde = baldes.get(chave);

  if (!balde || agora >= balde.reiniciaEm) {
    baldes.set(chave, { contagem: 1, reiniciaEm: agora + janelaMs });
    return { permitido: true, restante: limite - 1, esperarMs: 0 };
  }

  if (balde.contagem >= limite) {
    return { permitido: false, restante: 0, esperarMs: balde.reiniciaEm - agora };
  }

  balde.contagem += 1;
  return { permitido: true, restante: limite - balde.contagem, esperarMs: 0 };
}

function liberar(chave) {
  baldes.delete(chave);
}

function limpar() {
  const agora = Date.now();
  for (const [chave, balde] of baldes) {
    if (agora >= balde.reiniciaEm) baldes.delete(chave);
  }
}

setInterval(limpar, 5 * 60 * 1000).unref();

const REGRAS = {
  login: { limite: 8, janelaMs: 15 * 60 * 1000 },
  // Recuperacao de senha e mais restrita que o login: cada pedido dispara um
  // e-mail, e um atacante usaria a rota para inundar a caixa de um usuario.
  recuperacao: { limite: 5, janelaMs: 60 * 60 * 1000 },
  api: { limite: 300, janelaMs: 60 * 1000 },
  pesquisa: { limite: 20, janelaMs: 60 * 60 * 1000 },
  testeLlm: { limite: 10, janelaMs: 10 * 60 * 1000 },
};

module.exports = { consumir, liberar, REGRAS };
