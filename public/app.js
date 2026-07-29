'use strict';

/**
 * Front-end do Claves CRM IA.
 *
 * Regra de ouro deste arquivo: TODO conteudo vindo da API e inserido via
 * textContent / createElement — nunca innerHTML. Os dossies sao escritos por
 * um modelo de linguagem a partir de paginas da internet, ou seja, sao dados
 * nao confiaveis. Renderizar isso como HTML seria um XSS armado.
 */

const estado = {
  csrf: null,
  usuario: null,
  meta: null,
  leads: [],
  credenciais: [],
  execucaoAtiva: null,
};

// ------------------------------------------------------------- utilidades

const $ = (seletor) => document.querySelector(seletor);
const $$ = (seletor) => Array.from(document.querySelectorAll(seletor));

function el(tag, atributos = {}, filhos = []) {
  const no = document.createElement(tag);
  for (const [chave, valor] of Object.entries(atributos)) {
    if (valor === null || valor === undefined || valor === false) continue;
    if (chave === 'classe') no.className = valor;
    else if (chave === 'texto') no.textContent = valor;
    else if (chave === 'dados') Object.assign(no.dataset, valor);
    else if (chave.startsWith('on')) no.addEventListener(chave.slice(2).toLowerCase(), valor);
    else no.setAttribute(chave, valor);
  }
  for (const filho of [].concat(filhos)) {
    if (filho === null || filho === undefined || filho === false) continue;
    no.appendChild(typeof filho === 'string' ? document.createTextNode(filho) : filho);
  }
  return no;
}

function limpar(no) {
  while (no.firstChild) no.removeChild(no.firstChild);
}

let relogioToast = null;
function toast(mensagem, tipo = '') {
  const alvo = $('#toast');
  alvo.textContent = mensagem;
  alvo.className = `toast ${tipo}`;
  alvo.hidden = false;
  clearTimeout(relogioToast);
  relogioToast = setTimeout(() => {
    alvo.hidden = true;
  }, 5000);
}

function mostrarAlerta(seletor, mensagem, tipo = 'erro') {
  const no = $(seletor);
  no.textContent = mensagem;
  no.className = `alerta alerta-${tipo}`;
  no.hidden = !mensagem;
}

async function api(caminho, opcoes = {}) {
  const cabecalhos = { ...(opcoes.headers || {}) };
  if (opcoes.body) cabecalhos['Content-Type'] = 'application/json';
  if (estado.csrf) cabecalhos['X-CSRF-Token'] = estado.csrf;

  const resposta = await fetch(caminho, {
    ...opcoes,
    headers: cabecalhos,
    credentials: 'same-origin',
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });

  if (resposta.status === 401) {
    estado.usuario = null;
    mostrarLogin();
    throw new Error('Sessao expirada.');
  }

  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro || `Erro ${resposta.status}`);
  return dados;
}

function formatarData(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// ------------------------------------------------------------------ login

function mostrarLogin() {
  $('#tela-login').hidden = false;
  $('#app').hidden = true;
}

function mostrarApp() {
  $('#tela-login').hidden = true;
  $('#app').hidden = false;
  $('#usuario-atual').textContent = estado.usuario.nome || estado.usuario.email;
}

$('#form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  mostrarAlerta('#login-erro', '');
  try {
    const dados = await api('/api/auth/login', {
      method: 'POST',
      body: { email: $('#login-email').value, senha: $('#login-senha').value },
    });
    estado.usuario = dados.usuario;
    estado.csrf = dados.csrfToken;
    $('#login-senha').value = '';
    mostrarApp();
    await iniciarApp();
  } catch (falha) {
    mostrarAlerta('#login-erro', falha.message);
  }
});

$('#btn-sair').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* sessao ja invalida */ }
  estado.usuario = null;
  estado.csrf = null;
  mostrarLogin();
});

// -------------------------------------------------------------------- abas

$('#abas').addEventListener('click', (evento) => {
  const botao = evento.target.closest('.aba');
  if (!botao) return;
  const alvo = botao.dataset.aba;
  $$('.aba').forEach((b) => b.classList.toggle('ativa', b === botao));
  for (const nome of ['pipeline', 'buscar', 'icp', 'config']) {
    $(`#painel-${nome}`).hidden = nome !== alvo;
  }
  if (alvo === 'pipeline') carregarLeads();
  if (alvo === 'config') carregarConfiguracoes();
});

// ---------------------------------------------------------------- pipeline

function classePontuacao(valor) {
  if (valor >= 75) return 'pontuacao-alta';
  if (valor >= 50) return 'pontuacao-media';
  return 'pontuacao-baixa';
}

function renderizarResumo(resumo) {
  const alvo = $('#cartoes-resumo');
  limpar(alvo);

  const cartoes = [
    { rotulo: 'Leads ativos', numero: resumo.total - resumo.descartados },
    ...resumo.porTier.map((t) => ({ rotulo: `Tier ${t.tier}`, numero: t.quantidade })),
    { rotulo: 'Descartados', numero: resumo.descartados },
  ];

  for (const cartao of cartoes) {
    alvo.appendChild(
      el('div', { classe: 'cartao-resumo' }, [
        el('div', { classe: 'numero', texto: String(cartao.numero) }),
        el('div', { classe: 'rotulo', texto: cartao.rotulo }),
      ])
    );
  }
}

function renderizarLeads(leads) {
  const alvo = $('#lista-leads');
  limpar(alvo);
  $('#pipeline-vazio').hidden = leads.length > 0;

  for (const lead of leads) {
    const localizacao = [lead.empresa?.cidade, lead.empresa?.uf].filter(Boolean).join('/');
    const meta = [
      lead.empresa?.segmento,
      localizacao,
      lead.volumeEstimadoVagas ? `~${lead.volumeEstimadoVagas} vagas` : null,
      `${lead.totalDecisores} decisor(es)`,
      `${lead.totalSinais} sinal(is)`,
    ]
      .filter(Boolean)
      .join(' · ');

    const etiquetas = el('div', { classe: 'etiquetas' }, [
      lead.tier ? el('span', { classe: `etiqueta etiqueta-tier${lead.tier}`, texto: `Tier ${lead.tier}` }) : null,
      el('span', { classe: 'etiqueta etiqueta-neutra', texto: lead.status }),
      lead.antiPersona?.atingido
        ? el('span', { classe: 'etiqueta etiqueta-erro', texto: 'anti-persona' })
        : null,
      el('span', {
        classe: `etiqueta ${lead.confianca === 'alta' ? 'etiqueta-ok' : lead.confianca === 'media' ? 'etiqueta-aviso' : 'etiqueta-neutra'}`,
        texto: `confiança ${lead.confianca}`,
      }),
    ]);

    const cartao = el(
      'article',
      {
        classe: `cartao-lead tier-${lead.tier || 0}${lead.status === 'descartado' ? ' descartado' : ''}`,
        dados: { id: lead.id },
        onclick: () => abrirGaveta(lead.id),
      },
      [
        el('div', {}, [
          el('div', { classe: 'lead-titulo', texto: lead.empresa?.nome || 'Sem nome' }),
          el('div', { classe: 'lead-meta', texto: meta }),
          el('div', { classe: 'lead-porque', texto: lead.porqueClaves || '' }),
        ]),
        el('div', { classe: 'lead-lateral' }, [
          el('div', { classe: `pontuacao ${classePontuacao(lead.score)}`, texto: String(lead.score ?? 0) }),
          etiquetas,
        ]),
      ]
    );

    alvo.appendChild(cartao);
  }
}

async function carregarLeads() {
  const params = new URLSearchParams();
  const busca = $('#filtro-busca').value.trim();
  if (busca) params.set('q', busca);
  if ($('#filtro-tier').value) params.set('tier', $('#filtro-tier').value);
  if ($('#filtro-status').value) params.set('status', $('#filtro-status').value);
  if ($('#filtro-descartados').checked) params.set('descartados', '1');

  try {
    const dados = await api(`/api/leads?${params}`);
    estado.leads = dados.leads;
    renderizarResumo(dados.resumo);
    renderizarLeads(dados.leads);
  } catch (falha) {
    toast(falha.message, 'erro');
  }
}

let relogioFiltro = null;
$('#filtro-busca').addEventListener('input', () => {
  clearTimeout(relogioFiltro);
  relogioFiltro = setTimeout(carregarLeads, 300);
});
$('#filtro-tier').addEventListener('change', carregarLeads);
$('#filtro-status').addEventListener('change', carregarLeads);
$('#filtro-descartados').addEventListener('change', carregarLeads);

// ------------------------------------------------------- gaveta / detalhe

function bloco(titulo, filhos) {
  return el('section', { classe: 'bloco' }, [
    el('div', { classe: 'bloco-titulo', texto: titulo }),
    ...[].concat(filhos),
  ]);
}

/**
 * As URLs dos dossies vem do LLM, que as extraiu de paginas da internet.
 * Colocar isso direto num href aceitaria "javascript:..." — XSS a um clique
 * de distancia. So http e https passam; o resto vira texto simples.
 */
function urlSegura(bruta) {
  if (!bruta) return null;
  try {
    const url = new URL(String(bruta), window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function linkExterno(url, rotulo) {
  if (!url) return null;
  const destino = urlSegura(url);
  // Sem destino seguro, mostramos o texto sem tornar clicavel.
  if (!destino) return el('span', { classe: 'secundario', texto: rotulo || String(url) });
  return el('a', { href: destino, target: '_blank', rel: 'noopener noreferrer nofollow', texto: rotulo || destino });
}

function renderizarDecisor(contato) {
  const rotuloStatus = {
    confirmado_atual: ['etiqueta-ok', 'cargo confirmado'],
    provavel_atual: ['etiqueta-aviso', 'provavelmente atual'],
    nao_confirmado: ['etiqueta-neutra', 'nao confirmado'],
  }[contato.statusAtual] || ['etiqueta-neutra', contato.statusAtual];

  const contatos = [contato.emailPublico, contato.telefonePublico].filter(Boolean).join(' · ');

  return el('div', { classe: 'item-lista' }, [
    el('div', { classe: 'principal', texto: contato.nomeCompleto }),
    el('div', { classe: 'secundario', texto: contato.cargo }),
    el('div', { classe: 'etiquetas', style: 'margin:.4rem 0' }, [
      el('span', { classe: `etiqueta ${rotuloStatus[0]}`, texto: rotuloStatus[1] }),
      el('span', { classe: 'etiqueta etiqueta-neutra', texto: `evidência: ${contato.dataDaEvidencia || 'sem data'}` }),
      el('span', { classe: 'etiqueta etiqueta-neutra', texto: `confiança ${contato.confianca}` }),
    ]),
    contatos ? el('div', { classe: 'secundario', texto: contatos }) : null,
    contato.trechoEvidencia ? el('div', { classe: 'citacao', texto: `"${contato.trechoEvidencia}"` }) : null,
    el('div', { classe: 'secundario', style: 'margin-top:.4rem' }, [
      contato.linkedinUrl ? linkExterno(contato.linkedinUrl, 'LinkedIn') : null,
      contato.linkedinUrl && contato.fonteUrl ? ' · ' : null,
      contato.fonteUrl ? linkExterno(contato.fonteUrl, 'fonte') : null,
    ]),
  ]);
}

function renderizarSinal(sinal) {
  return el('div', { classe: 'item-lista' }, [
    el('div', { classe: 'principal', texto: sinal.tipo }),
    el('div', { classe: 'secundario', texto: sinal.descricao }),
    el('div', { classe: 'secundario', style: 'margin-top:.3rem' }, [
      sinal.dataDoSinal ? `${sinal.dataDoSinal} · ` : '',
      linkExterno(sinal.fonteUrl, sinal.fonteTitulo || 'fonte'),
    ]),
  ]);
}

function renderizarVaga(vaga) {
  const detalhe = [
    vaga.especialidade,
    [vaga.cidade, vaga.uf].filter(Boolean).join('/'),
    vaga.diasAberta ? `aberta há ${vaga.diasAberta} dias` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return el('div', { classe: 'item-lista' }, [
    el('div', { classe: 'principal', texto: vaga.titulo }),
    detalhe ? el('div', { classe: 'secundario', texto: detalhe }) : null,
    vaga.fonteUrl ? el('div', { classe: 'secundario' }, [linkExterno(vaga.fonteUrl, 'ver vaga')]) : null,
  ]);
}

async function abrirGaveta(leadId) {
  let dados;
  try {
    dados = await api(`/api/leads/${encodeURIComponent(leadId)}`);
  } catch (falha) {
    return toast(falha.message, 'erro');
  }

  const { lead, contatos } = dados;
  const painel = $('#gaveta-painel');
  limpar(painel);

  const seletorStatus = el(
    'select',
    {
      classe: 'campo campo-curto',
      onchange: async (evento) => {
        try {
          await api(`/api/leads/${encodeURIComponent(lead.id)}`, {
            method: 'PATCH',
            body: { status: evento.target.value },
          });
          toast('Status atualizado.', 'ok');
          carregarLeads();
        } catch (falha) {
          toast(falha.message, 'erro');
        }
      },
    },
    (estado.meta?.status || []).map((s) =>
      el('option', { value: s, texto: s, selected: s === lead.status })
    )
  );

  painel.appendChild(
    el('div', { classe: 'gaveta-cabecalho' }, [
      el('div', {}, [
        el('h2', { texto: lead.empresa?.nome || 'Sem nome' }),
        el('div', { classe: 'lead-meta' }, [
          [lead.empresa?.cidade, lead.empresa?.uf].filter(Boolean).join('/') || 'local não informado',
          lead.empresa?.site ? ' · ' : null,
          lead.empresa?.site ? linkExterno(lead.empresa.site, 'site') : null,
        ]),
      ]),
      el('button', { classe: 'btn btn-fantasma', texto: '✕ Fechar', onclick: fecharGaveta }),
    ])
  );

  painel.appendChild(
    el('div', { classe: 'etiquetas', style: 'margin-bottom:1.25rem' }, [
      lead.tier ? el('span', { classe: `etiqueta etiqueta-tier${lead.tier}`, texto: `Tier ${lead.tier}` }) : null,
      el('span', { classe: 'etiqueta etiqueta-neutra', texto: `score ${lead.score}` }),
      el('span', { classe: 'etiqueta etiqueta-neutra', texto: `confiança ${lead.confianca}` }),
      lead.antiPersona?.atingido
        ? el('span', { classe: 'etiqueta etiqueta-erro', texto: 'anti-persona' })
        : null,
    ])
  );

  painel.appendChild(el('div', { style: 'margin-bottom:1.25rem' }, [seletorStatus]));

  if (lead.porqueClaves) {
    painel.appendChild(
      bloco('Por que este lead precisa da Claves', el('div', { classe: 'caixa-destaque', texto: lead.porqueClaves }))
    );
  }

  if (lead.ganchoAbordagem) {
    painel.appendChild(bloco('Gancho de abordagem', el('div', { classe: 'caixa-destaque', texto: lead.ganchoAbordagem })));
  }

  if (lead.antiPersona?.atingido) {
    painel.appendChild(
      bloco('Alerta de anti-persona', [
        el('p', { classe: 'alerta alerta-erro', texto: lead.antiPersona.justificativa || 'Perfil marcado como anti-persona.' }),
        el('div', { classe: 'etiquetas' }, (lead.antiPersona.codigos || []).map((c) =>
          el('span', { classe: 'etiqueta etiqueta-erro', texto: c })
        )),
      ])
    );
  }

  painel.appendChild(
    bloco(`Quem aprova a compra (${contatos.length})`,
      contatos.length
        ? contatos.map(renderizarDecisor)
        : el('p', { classe: 'ajuda', texto: 'Nenhum decisor confirmado nesta execução.' })
    )
  );

  if ((lead.sinaisDeCompra || []).length) {
    painel.appendChild(bloco('Sinais de compra', lead.sinaisDeCompra.map(renderizarSinal)));
  }

  if ((lead.vagasAbertas || []).length) {
    painel.appendChild(
      bloco(
        'Evidência da dor — vagas que esta empresa tem abertas',
        lead.vagasAbertas.map(renderizarVaga)
      )
    );
  }

  const ficha = el('table', { classe: 'tabela-dados' });
  const linhas = [
    ['Segmento', lead.empresa?.segmento],
    ['Abrangência', lead.empresa?.abrangencia],
    ['Porte estimado', lead.empresa?.porteEstimado],
    ['CNPJ', lead.empresa?.cnpj],
    ['Vagas estimadas', lead.volumeEstimadoVagas],
    ['Dor identificada', lead.dorIdentificada],
    ['Justificativa do tier', lead.justificativaTier],
    ['Próximo passo', lead.proximoPasso],
    ['Observações', lead.observacoes],
    ['Atualizado em', formatarData(lead.atualizadoEm)],
  ];
  for (const [rotulo, valor] of linhas) {
    if (!valor) continue;
    ficha.appendChild(el('tr', {}, [el('th', { texto: rotulo }), el('td', { texto: String(valor) })]));
  }
  painel.appendChild(bloco('Ficha', ficha));

  if ((lead.fontes || []).length) {
    painel.appendChild(
      bloco('Fontes consultadas',
        el('div', {}, lead.fontes.map((f) =>
          el('div', { classe: 'secundario', style: 'margin-bottom:.3rem' }, [linkExterno(f.url, f.titulo || f.url)])
        ))
      )
    );
  }

  const campoNota = el('textarea', { classe: 'campo', rows: '3', placeholder: 'Registrar uma nota...' });
  painel.appendChild(
    bloco('Notas', [
      ...(lead.notas || []).map((n) =>
        el('div', { classe: 'item-lista' }, [
          el('div', { classe: 'secundario', texto: `${n.autor} · ${formatarData(n.em)}` }),
          el('div', { texto: n.texto }),
        ])
      ),
      campoNota,
      el('button', {
        classe: 'btn btn-secundario btn-mini',
        texto: 'Adicionar nota',
        onclick: async () => {
          if (!campoNota.value.trim()) return;
          try {
            await api(`/api/leads/${encodeURIComponent(lead.id)}`, {
              method: 'PATCH',
              body: { nota: campoNota.value },
            });
            toast('Nota adicionada.', 'ok');
            abrirGaveta(lead.id);
          } catch (falha) {
            toast(falha.message, 'erro');
          }
        },
      }),
    ])
  );

  painel.appendChild(
    el('button', {
      classe: 'btn btn-perigo btn-bloco',
      texto: 'Excluir lead',
      onclick: async () => {
        if (!confirm(`Excluir "${lead.empresa?.nome}" e seus contatos? Esta ação não pode ser desfeita.`)) return;
        try {
          await api(`/api/leads/${encodeURIComponent(lead.id)}`, { method: 'DELETE' });
          fecharGaveta();
          carregarLeads();
          toast('Lead excluído.', 'ok');
        } catch (falha) {
          toast(falha.message, 'erro');
        }
      },
    })
  );

  $('#gaveta').hidden = false;
}

function fecharGaveta() {
  $('#gaveta').hidden = true;
}

$('#gaveta-fundo').addEventListener('click', fecharGaveta);
document.addEventListener('keydown', (evento) => {
  if (evento.key === 'Escape') fecharGaveta();
});

// ----------------------------------------------------------- console log

function registrarLog(texto, classe = '') {
  const console = $('#console-agente');
  const vazio = console.querySelector('.console-vazio');
  if (vazio) vazio.remove();

  const hora = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.appendChild(
    el('div', { classe: `linha-log ${classe}` }, [
      el('span', { classe: 'hora', texto: hora }),
      el('span', { classe: 'corpo', texto }),
    ])
  );
  console.scrollTop = console.scrollHeight;
}

// -------------------------------------------------------------- pesquisa

const MANIPULADORES_EVENTO = {
  inicio: (d) =>
    registrarLog(
      `Iniciando: ${d.provedor} / ${d.modelo} · busca ${d.buscaWeb} · profundidade ${d.profundidade} · tiers ${d.tiers.join(', ')} · ${d.regiao}`,
      'log-fase'
    ),
  fase: (d) =>
    registrarLog(
      `FASE ${d.nome.toUpperCase()}: ${d.descricao}${d.total ? ` (${d.indice}/${d.total})` : ''}`,
      'log-fase'
    ),
  progresso: (d) => registrarLog(`· iteração ${d.iteracao}/${d.maxIteracoes} [${d.fase}]`, 'log-pensamento'),
  ferramenta: (d) => registrarLog(`→ ${d.nome}${d.entrada ? `: ${d.entrada}` : ''}`, 'log-ferramenta'),
  pensamento: (d) => registrarLog(d.texto, 'log-pensamento'),
  candidata: (d) => registrarLog(`● candidata: ${d.nome} (Tier ${d.tier}) — ${d.motivo}`, 'log-candidata'),
  descarte: (d) => registrarLog(`✕ descartada: ${d.nome} [${d.codigo}] — ${d.motivo}`, 'log-descarte'),
  dossie: (d) =>
    registrarLog(
      `✔ dossiê: ${d.empresa} · Tier ${d.tier} · score ${d.score} · ${d.decisores} decisor(es)`,
      'log-dossie'
    ),
  descobertaConcluida: (d) =>
    registrarLog(
      `Descoberta concluída: ${d.candidatas} candidatas, ${d.descartes} descartes. Aprofundando ${d.aprofundar}.`,
      'log-fase'
    ),
  leadGravado: (d) => registrarLog(`💾 salvo: ${d.empresa}${d.novo ? '' : ' (atualizado)'}`, 'log-dossie'),
  aviso: (d) => registrarLog(`⚠ ${d.mensagem}`, 'log-aviso'),
  erro: (d) => registrarLog(`ERRO: ${d.mensagem}`, 'log-erro'),
  fim: (d) =>
    registrarLog(
      `Concluído: ${d.leadsGravados} lead(s) gravado(s), ${d.descartados} descarte(s). Tokens: ${d.uso.entrada} entrada / ${d.uso.saida} saída.`,
      'log-fim'
    ),
};

async function executarPesquisa() {
  const tiers = $$('#tiers-opcoes input:checked').map((i) => Number(i.value));
  if (!tiers.length) return mostrarAlerta('#busca-alerta', 'Selecione ao menos um tier.');

  mostrarAlerta('#busca-alerta', '');
  limpar($('#console-agente'));

  const controlador = new AbortController();
  estado.execucaoAtiva = controlador;
  $('#btn-pesquisar').disabled = true;
  $('#btn-pesquisar').textContent = 'Pesquisando...';
  $('#btn-cancelar').hidden = false;

  try {
    const resposta = await fetch('/api/pesquisar', {
      method: 'POST',
      credentials: 'same-origin',
      signal: controlador.signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': estado.csrf },
      body: JSON.stringify({
        tiers,
        regiao: $('#campo-regiao').value,
        segmento: $('#campo-segmento').value,
        profundidade: $('#campo-profundidade').value,
        credencialId: $('#campo-credencial').value || null,
      }),
    });

    if (!resposta.ok) {
      const falha = await resposta.json().catch(() => ({}));
      throw new Error(falha.erro || `Erro ${resposta.status}`);
    }

    // Leitura manual do fluxo SSE (EventSource nao suporta POST).
    const leitor = resposta.body.getReader();
    const decodificador = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      buffer += decodificador.decode(value, { stream: true });

      const partes = buffer.split('\n\n');
      buffer = partes.pop() || '';

      for (const parte of partes) {
        let evento = 'message';
        const linhasDados = [];
        for (const linha of parte.split('\n')) {
          if (linha.startsWith('event: ')) evento = linha.slice(7).trim();
          else if (linha.startsWith('data: ')) linhasDados.push(linha.slice(6));
        }
        if (!linhasDados.length) continue;

        let dados;
        try {
          dados = JSON.parse(linhasDados.join('\n'));
        } catch {
          continue;
        }

        const manipulador = MANIPULADORES_EVENTO[evento];
        if (manipulador) manipulador(dados);
        if (evento === 'leadGravado' || evento === 'fim') carregarLeads();
      }
    }
  } catch (falha) {
    if (falha.name === 'AbortError') registrarLog('Pesquisa cancelada pelo usuário.', 'log-aviso');
    else {
      registrarLog(`ERRO: ${falha.message}`, 'log-erro');
      mostrarAlerta('#busca-alerta', falha.message);
    }
  } finally {
    estado.execucaoAtiva = null;
    $('#btn-pesquisar').disabled = false;
    $('#btn-pesquisar').textContent = 'Buscar empresas que precisam da Claves';
    $('#btn-cancelar').hidden = true;
  }
}

$('#btn-pesquisar').addEventListener('click', executarPesquisa);
$('#btn-cancelar').addEventListener('click', () => estado.execucaoAtiva?.abort());

// -------------------------------------------------------------- ICP view

function renderizarIcp() {
  const alvo = $('#conteudo-icp');
  limpar(alvo);

  for (const tier of estado.meta.tiers) {
    alvo.appendChild(
      el('section', { classe: 'cartao cartao-icp' }, [
        el('div', { classe: 'etiquetas', style: 'margin-bottom:.5rem' }, [
          el('span', { classe: `etiqueta etiqueta-tier${tier.id}`, texto: `Tier ${tier.id}` }),
        ]),
        el('h2', { texto: tier.nome }),
        el('p', { classe: 'ajuda', texto: tier.resumo }),
        el('div', { classe: 'bloco-titulo', texto: 'Dor real' }),
        el('p', { texto: tier.dorReal }),
        el('div', { classe: 'bloco-titulo', texto: 'Sinais de compra' }),
        el('ul', {}, tier.sinaisDeCompra.map((s) => el('li', { texto: s }))),
        el('div', { classe: 'bloco-titulo', texto: 'Quem decide' }),
        el('ul', {}, tier.decisores.map((d) => el('li', { texto: d }))),
        el('div', { classe: 'bloco-titulo', texto: 'Onde caçar' }),
        el('ul', {}, tier.ondeCacar.map((o) => el('li', { texto: o }))),
        tier.clienteEspelho ? el('div', { classe: 'bloco-titulo', texto: 'Cliente-espelho' }) : null,
        tier.clienteEspelho ? el('div', { classe: 'caixa-destaque', texto: tier.clienteEspelho }) : null,
      ])
    );
  }

  alvo.appendChild(
    el('section', { classe: 'cartao cartao-icp' }, [
      el('h2', { texto: 'Anti-persona — não gastar munição' }),
      el('p', { classe: 'ajuda', texto: 'O agente descarta automaticamente leads que se encaixem nestes perfis.' }),
      ...estado.meta.antiPersona.map((a) =>
        el('div', { classe: 'item-lista' }, [
          el('div', { classe: 'principal', texto: a.titulo }),
          el('div', { classe: 'secundario', texto: a.porque }),
          el('div', { classe: 'etiquetas', style: 'margin-top:.4rem' }, [
            el('span', { classe: 'etiqueta etiqueta-erro', texto: a.codigo }),
          ]),
        ])
      ),
    ])
  );
}

// --------------------------------------------------------- configuracoes

function renderizarCredenciais(credenciais) {
  const alvo = $('#lista-credenciais');
  limpar(alvo);

  if (!credenciais.length) {
    alvo.appendChild(el('p', { classe: 'ajuda', texto: 'Nenhuma chave cadastrada ainda.' }));
    return;
  }

  for (const credencial of credenciais) {
    const acoes = el('div', { classe: 'linha-botoes', style: 'margin:.6rem 0 0' }, [
      credencial.ativo
        ? null
        : el('button', {
            classe: 'btn btn-secundario btn-mini',
            texto: 'Usar esta',
            onclick: async () => {
              try {
                await api(`/api/config/llm/${encodeURIComponent(credencial.id)}/ativar`, { method: 'POST' });
                toast('Credencial ativada.', 'ok');
                carregarConfiguracoes();
              } catch (falha) {
                toast(falha.message, 'erro');
              }
            },
          }),
      el('button', {
        classe: 'btn btn-secundario btn-mini',
        texto: 'Testar',
        onclick: async (evento) => {
          const botao = evento.target;
          botao.disabled = true;
          botao.textContent = 'Testando...';
          try {
            const resultado = await api(`/api/config/llm/${encodeURIComponent(credencial.id)}/testar`, { method: 'POST' });
            toast(`OK — ${resultado.modelo} respondeu "${resultado.amostra}"`, 'ok');
          } catch (falha) {
            toast(falha.message, 'erro');
          } finally {
            botao.disabled = false;
            botao.textContent = 'Testar';
            carregarConfiguracoes();
          }
        },
      }),
      el('button', {
        classe: 'btn btn-perigo btn-mini',
        texto: 'Excluir',
        onclick: async () => {
          if (!confirm(`Excluir a credencial "${credencial.apelido}"?`)) return;
          try {
            await api(`/api/config/llm/${encodeURIComponent(credencial.id)}`, { method: 'DELETE' });
            toast('Credencial removida.', 'ok');
            carregarConfiguracoes();
          } catch (falha) {
            toast(falha.message, 'erro');
          }
        },
      }),
    ]);

    alvo.appendChild(
      el('div', { classe: `credencial${credencial.ativo ? ' ativa' : ''}` }, [
        el('div', { classe: 'etiquetas', style: 'margin-bottom:.35rem' }, [
          credencial.ativo ? el('span', { classe: 'etiqueta etiqueta-ok', texto: 'em uso' }) : null,
          credencial.suportaBuscaWebNativa
            ? el('span', { classe: 'etiqueta etiqueta-ok', texto: 'busca web nativa' })
            : el('span', { classe: 'etiqueta etiqueta-aviso', texto: 'precisa de API de busca' }),
          credencial.ultimoTesteOk === true ? el('span', { classe: 'etiqueta etiqueta-ok', texto: 'teste ok' }) : null,
          credencial.ultimoTesteOk === false ? el('span', { classe: 'etiqueta etiqueta-erro', texto: 'teste falhou' }) : null,
        ]),
        el('div', { classe: 'principal', texto: credencial.apelido }),
        el('div', { classe: 'secundario', texto: `${credencial.nomeProvedor} · ${credencial.modelo}` }),
        credencial.baseUrl ? el('div', { classe: 'secundario', texto: credencial.baseUrl }) : null,
        el('div', { classe: 'chave', texto: credencial.chaveMascarada }),
        acoes,
      ])
    );
  }
}

function atualizarSeletorCredenciais() {
  const seletor = $('#campo-credencial');
  limpar(seletor);

  if (!estado.credenciais.length) {
    seletor.appendChild(el('option', { value: '', texto: 'Nenhuma credencial — configure primeiro' }));
    return;
  }
  for (const credencial of estado.credenciais) {
    seletor.appendChild(
      el('option', {
        value: credencial.id,
        texto: `${credencial.apelido} — ${credencial.modelo}${credencial.ativo ? ' (padrão)' : ''}`,
        selected: credencial.ativo,
      })
    );
  }
}

function atualizarModelosSugeridos() {
  const provedorId = $('#cfg-provedor').value;
  const provedor = estado.meta.provedoresLlm.find((p) => p.id === provedorId);
  const lista = $('#lista-modelos');
  limpar(lista);
  if (!provedor) return;

  for (const modelo of provedor.modelosSugeridos) {
    lista.appendChild(el('option', { value: modelo.id, label: modelo.rotulo }));
  }
  if (!$('#cfg-modelo').value) $('#cfg-modelo').value = provedor.modelosSugeridos[0]?.id || '';
  $('#cfg-baseurl').placeholder = provedor.baseUrlPadrao || 'https://...';
}

async function carregarConfiguracoes() {
  try {
    const dados = await api('/api/config');
    estado.credenciais = dados.credenciais;
    renderizarCredenciais(dados.credenciais);
    atualizarSeletorCredenciais();

    $('#busca-status').textContent = dados.buscaWeb
      ? `Configurado: ${dados.buscaWeb.provedor} · ${dados.buscaWeb.chaveMascarada}`
      : 'Nenhuma API de busca configurada.';

    const seguranca = $('#lista-seguranca');
    limpar(seguranca);
    const itens = [
      'Chaves de API cifradas em repouso com AES-256-GCM.',
      'Sessão com cookie httpOnly + SameSite=Strict e proteção CSRF.',
      'Requisições de saída bloqueiam endereços de rede interna (anti-SSRF).',
      'A pasta data/ está no .gitignore — nada de segredo vai para o Git.',
    ];
    if (dados.chaveMestraEfemera) {
      itens.unshift('ATENÇÃO: APP_MASTER_KEY não definida. As chaves salvas se perdem no restart.');
    }
    for (const item of itens) seguranca.appendChild(el('li', { texto: item }));
  } catch (falha) {
    toast(falha.message, 'erro');
  }
}

$('#cfg-provedor').addEventListener('change', () => {
  $('#cfg-modelo').value = '';
  atualizarModelosSugeridos();
});

$('#btn-salvar-llm').addEventListener('click', async () => {
  mostrarAlerta('#cfg-alerta', '');
  try {
    await api('/api/config/llm', {
      method: 'POST',
      body: {
        provedor: $('#cfg-provedor').value,
        apelido: $('#cfg-apelido').value,
        modelo: $('#cfg-modelo').value,
        baseUrl: $('#cfg-baseurl').value,
        apiKey: $('#cfg-chave').value,
      },
    });
    $('#cfg-chave').value = '';
    $('#cfg-apelido').value = '';
    mostrarAlerta('#cfg-alerta', 'Chave salva e cifrada com sucesso.', 'ok');
    carregarConfiguracoes();
  } catch (falha) {
    mostrarAlerta('#cfg-alerta', falha.message);
  }
});

$('#btn-salvar-busca').addEventListener('click', async () => {
  try {
    await api('/api/config/busca', {
      method: 'POST',
      body: { provedor: $('#cfg-busca-provedor').value, apiKey: $('#cfg-busca-chave').value },
    });
    $('#cfg-busca-chave').value = '';
    toast('API de busca configurada.', 'ok');
    carregarConfiguracoes();
  } catch (falha) {
    toast(falha.message, 'erro');
  }
});

$('#btn-remover-busca').addEventListener('click', async () => {
  try {
    await api('/api/config/busca', { method: 'DELETE' });
    toast('API de busca removida.', 'ok');
    carregarConfiguracoes();
  } catch (falha) {
    toast(falha.message, 'erro');
  }
});

$('#btn-trocar-senha').addEventListener('click', async () => {
  mostrarAlerta('#senha-alerta', '');
  try {
    const resultado = await api('/api/auth/senha', {
      method: 'POST',
      body: { senhaAtual: $('#senha-atual').value, novaSenha: $('#senha-nova').value },
    });
    $('#senha-atual').value = '';
    $('#senha-nova').value = '';
    mostrarAlerta('#senha-alerta', resultado.mensagem, 'ok');
    setTimeout(() => {
      estado.usuario = null;
      mostrarLogin();
    }, 2000);
  } catch (falha) {
    mostrarAlerta('#senha-alerta', falha.message);
  }
});

// ------------------------------------------------------------------- boot

function montarOpcoesTier() {
  const alvo = $('#tiers-opcoes');
  limpar(alvo);
  for (const tier of estado.meta.tiers) {
    alvo.appendChild(
      el('label', { classe: 'opcao-tier' }, [
        el('input', { type: 'checkbox', value: String(tier.id), checked: tier.id === 1 }),
        el('span', {}, [
          el('span', { classe: 'titulo', texto: `Tier ${tier.id} — ${tier.nome}` }),
          el('br'),
          el('span', { classe: 'descricao', texto: tier.resumo }),
        ]),
      ])
    );
  }
}

async function iniciarApp() {
  estado.meta = await api('/api/meta');

  montarOpcoesTier();
  renderizarIcp();

  const seletorStatus = $('#filtro-status');
  for (const status of estado.meta.status) {
    seletorStatus.appendChild(el('option', { value: status, texto: status }));
  }

  const seletorProvedor = $('#cfg-provedor');
  limpar(seletorProvedor);
  for (const provedor of estado.meta.provedoresLlm) {
    seletorProvedor.appendChild(el('option', { value: provedor.id, texto: provedor.nome }));
  }
  atualizarModelosSugeridos();

  const seletorBusca = $('#cfg-busca-provedor');
  limpar(seletorBusca);
  for (const provedor of estado.meta.provedoresBusca) {
    seletorBusca.appendChild(el('option', { value: provedor.id, texto: provedor.nome }));
  }

  await carregarConfiguracoes();
  await carregarLeads();
}

(async function principal() {
  try {
    const sessao = await api('/api/auth/sessao');
    estado.usuario = sessao.usuario;
    estado.csrf = sessao.csrfToken;
    mostrarApp();
    await iniciarApp();
  } catch {
    mostrarLogin();
  }
})();
