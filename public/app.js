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
  // A lista de paineis sai do proprio DOM: aba nova passa a funcionar sem
  // precisar lembrar de atualizar um array aqui.
  for (const botaoAba of $$('.aba')) {
    const painel = $(`#painel-${botaoAba.dataset.aba}`);
    if (painel) painel.hidden = botaoAba.dataset.aba !== alvo;
  }
  if (alvo === 'pipeline') carregarLeads();
  if (alvo === 'config') carregarConfiguracoes();
  if (alvo === 'kanban') carregarKanban();
  if (alvo === 'equipe') carregarEquipe();
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

// ==========================================================================
// KANBAN — o lead vai para o quadro de quem apertou o botao
// ==========================================================================

const ROTULO_STATUS = {
  novo: 'Novo',
  qualificado: 'Qualificado',
  contatado: 'Contatado',
  reuniao: 'Reunião',
  proposta: 'Proposta',
  ganho: 'Ganho',
  perdido: 'Perdido',
};

function cartaoKanban(cartao) {
  const no = el('article', {
    classe: `cartao-kanban tier-${cartao.tier || 0}`,
    draggable: 'true',
    dados: { leadId: cartao.id, status: cartao.status },
    onclick: () => abrirGaveta(cartao.id),
  }, [
    el('div', { classe: 'cartao-kanban-topo' }, [
      el('strong', { texto: cartao.empresa || 'Sem nome' }),
      el('span', { classe: `pontuacao ${classePontuacao(cartao.score)}`, texto: String(cartao.score ?? '—') }),
    ]),
    el('div', { classe: 'cartao-kanban-meta' }, [
      cartao.tier ? el('span', { classe: 'etiqueta', texto: `Tier ${cartao.tier}` }) : null,
      cartao.cidade ? el('span', { classe: 'secundario', texto: `${cartao.cidade}${cartao.uf ? '/' + cartao.uf : ''}` }) : null,
      cartao.volumeEstimadoVagas
        ? el('span', { classe: 'secundario', texto: `${cartao.volumeEstimadoVagas} vagas` })
        : null,
      el('span', { classe: 'secundario', texto: `${cartao.totalDecisores} decisor(es)` }),
    ]),
    // Dono so aparece para quem ve o pipeline da equipe; no kanban proprio
    // seria ruido, ja que todo cartao e do mesmo dono.
    estado.meta?.permissoes?.verTodosLeads && cartao.donoNome
      ? el('div', { classe: 'cartao-kanban-dono', texto: cartao.donoNome })
      : null,
  ]);

  no.addEventListener('dragstart', (evento) => {
    evento.dataTransfer.setData('text/plain', cartao.id);
    evento.dataTransfer.effectAllowed = 'move';
    no.classList.add('arrastando');
  });
  no.addEventListener('dragend', () => no.classList.remove('arrastando'));

  return no;
}

async function moverLead(leadId, novoStatus) {
  try {
    await api(`/api/leads/${encodeURIComponent(leadId)}`, {
      method: 'PATCH',
      body: { status: novoStatus },
    });
    toast(`Movido para ${ROTULO_STATUS[novoStatus] || novoStatus}.`, 'ok');
    await carregarKanban();
  } catch (falha) {
    toast(falha.message, 'erro');
    await carregarKanban(); // devolve o cartao ao lugar
  }
}

function colunaKanban(coluna) {
  const lista = el('div', { classe: 'coluna-corpo' },
    coluna.cartoes.map(cartaoKanban));

  const no = el('section', { classe: 'coluna', dados: { status: coluna.status } }, [
    el('header', { classe: 'coluna-topo' }, [
      el('span', { texto: ROTULO_STATUS[coluna.status] || coluna.status }),
      el('span', { classe: 'coluna-contador', texto: String(coluna.total) }),
    ]),
    lista,
  ]);

  no.addEventListener('dragover', (evento) => {
    evento.preventDefault();
    evento.dataTransfer.dropEffect = 'move';
    no.classList.add('coluna-alvo');
  });
  no.addEventListener('dragleave', () => no.classList.remove('coluna-alvo'));
  no.addEventListener('drop', (evento) => {
    evento.preventDefault();
    no.classList.remove('coluna-alvo');
    const leadId = evento.dataTransfer.getData('text/plain');
    if (!leadId) return;
    const atual = document.querySelector(`[data-lead-id="${CSS.escape(leadId)}"]`);
    if (atual?.dataset.status === coluna.status) return; // soltou na mesma coluna
    moverLead(leadId, coluna.status);
  });

  return no;
}

async function carregarKanban() {
  const filtro = $('#kanban-filtro-dono')?.value || '';
  const consulta = filtro ? `?dono=${encodeURIComponent(filtro)}` : '';

  let dados;
  try {
    dados = await api(`/api/kanban${consulta}`);
  } catch (falha) {
    toast(falha.message, 'erro');
    return;
  }

  const quadro = $('#quadro-kanban');
  limpar(quadro);
  for (const coluna of dados.colunas) quadro.appendChild(colunaKanban(coluna));

  const total = dados.colunas.reduce((soma, c) => soma + c.total, 0);
  $('#kanban-vazio').hidden = total > 0;

  $('#kanban-titulo').textContent = dados.escopo === 'equipe' ? 'Pipeline da equipe' : 'Meu kanban';
  $('#kanban-escopo').textContent =
    dados.escopo === 'equipe'
      ? 'Você vê os leads de toda a equipe. Arraste para mudar o estágio.'
      : 'Só os leads que as suas pesquisas encontraram. Arraste para mudar o estágio.';
}

$('#btn-recarregar-kanban').addEventListener('click', carregarKanban);
$('#kanban-filtro-dono').addEventListener('change', carregarKanban);

// ==========================================================================
// EQUIPE — cadastro de gestor e SDR
// ==========================================================================

function linhaEquipe(pessoa) {
  const souEu = pessoa.id === estado.usuario.id;
  const acoes = el('div', { classe: 'linha-botoes' });

  if (!souEu) {
    acoes.appendChild(el('button', {
      classe: 'btn btn-secundario btn-mini',
      texto: pessoa.ativo ? 'Desativar' : 'Reativar',
      onclick: async () => {
        try {
          await api(`/api/usuarios/${encodeURIComponent(pessoa.id)}`, {
            method: 'PATCH',
            body: { ativo: !pessoa.ativo },
          });
          toast(pessoa.ativo ? 'Conta desativada.' : 'Conta reativada.', 'ok');
          await carregarEquipe();
        } catch (falha) {
          toast(falha.message, 'erro');
        }
      },
    }));

    acoes.appendChild(el('button', {
      classe: 'btn btn-secundario btn-mini',
      texto: 'Redefinir senha',
      onclick: async () => {
        const nova = prompt(`Nova senha para ${pessoa.nome} (mín. 12 caracteres):`);
        if (!nova) return;
        try {
          const r = await api(`/api/usuarios/${encodeURIComponent(pessoa.id)}/senha`, {
            method: 'POST',
            body: { novaSenha: nova },
          });
          toast(r.mensagem, 'ok');
        } catch (falha) {
          toast(falha.message, 'erro');
        }
      },
    }));

    if (pessoa.leadsAtivos > 0 && estado.meta?.permissoes?.reatribuirLead) {
      acoes.appendChild(el('button', {
        classe: 'btn btn-secundario btn-mini',
        texto: `Transferir ${pessoa.leadsAtivos} lead(s)`,
        onclick: async () => {
          const destinos = estado.equipe.filter((u) => u.id !== pessoa.id && u.ativo);
          if (!destinos.length) return toast('Não há outra conta ativa para receber.', 'erro');
          const nomes = destinos.map((d, i) => `${i + 1}) ${d.nome}`).join('\n');
          const escolha = prompt(`Transferir a carteira de ${pessoa.nome} para:\n${nomes}\n\nDigite o número:`);
          const destino = destinos[Number(escolha) - 1];
          if (!destino) return;
          try {
            const r = await api(`/api/usuarios/${encodeURIComponent(pessoa.id)}/transferir-leads`, {
              method: 'POST',
              body: { paraUsuarioId: destino.id },
            });
            toast(r.mensagem, 'ok');
            await carregarEquipe();
            await carregarKanban();
          } catch (falha) {
            toast(falha.message, 'erro');
          }
        },
      }));
    }
  }

  return el('div', { classe: `linha-equipe ${pessoa.ativo ? '' : 'inativa'}` }, [
    el('div', {}, [
      el('strong', { texto: pessoa.nome }),
      souEu ? el('span', { classe: 'etiqueta', texto: 'você' }) : null,
      pessoa.ativo ? null : el('span', { classe: 'etiqueta etiqueta-aviso', texto: 'desativado' }),
      el('div', { classe: 'secundario', texto: pessoa.email }),
      el('div', { classe: 'secundario', texto: `${pessoa.papel} · ${pessoa.leadsAtivos} lead(s) · último acesso: ${formatarData(pessoa.ultimoLogin)}` }),
    ]),
    acoes,
  ]);
}

async function carregarEquipe() {
  if (!estado.meta?.permissoes?.gerenciarUsuarios) return;
  try {
    const dados = await api('/api/usuarios');
    estado.equipe = dados.usuarios;

    const lista = $('#lista-equipe');
    limpar(lista);
    for (const pessoa of dados.usuarios) lista.appendChild(linhaEquipe(pessoa));

    // Filtro de dono no kanban, para o gestor focar um SDR.
    const seletor = $('#kanban-filtro-dono');
    const anterior = seletor.value;
    limpar(seletor);
    seletor.appendChild(el('option', { value: '', texto: 'Toda a equipe' }));
    for (const pessoa of dados.usuarios) {
      seletor.appendChild(el('option', { value: pessoa.id, texto: pessoa.nome }));
    }
    seletor.appendChild(el('option', { value: 'sem_dono', texto: '— sem dono —' }));
    seletor.value = anterior;
  } catch (falha) {
    toast(falha.message, 'erro');
  }
}

$('#btn-criar-usuario').addEventListener('click', async () => {
  mostrarAlerta('#eq-alerta', '');
  try {
    await api('/api/usuarios', {
      method: 'POST',
      body: {
        nome: $('#eq-nome').value,
        email: $('#eq-email').value,
        papel: $('#eq-papel').value,
        senha: $('#eq-senha').value,
      },
    });
    $('#eq-nome').value = '';
    $('#eq-email').value = '';
    $('#eq-senha').value = '';
    mostrarAlerta('#eq-alerta', 'Pessoa cadastrada. Ela precisa trocar a senha no primeiro acesso.', 'ok');
    await carregarEquipe();
  } catch (falha) {
    mostrarAlerta('#eq-alerta', falha.message);
  }
});

$('#eq-papel').addEventListener('change', () => {
  const descricao = estado.meta?.descricaoPapeis?.[$('#eq-papel').value] || '';
  $('#eq-papel-descricao').textContent = descricao;
});

// ==========================================================================
// E-MAIL — configuracao SMTP
// ==========================================================================

async function carregarConfigEmail() {
  if (!estado.meta?.permissoes?.configurarIntegracoes) return;
  try {
    const { email } = await api('/api/config/email');
    if (!email) return;
    $('#cfg-email-host').value = email.host || '';
    $('#cfg-email-porta').value = String(email.porta || 587);
    $('#cfg-email-usuario').value = email.usuario || '';
    $('#cfg-email-remetente').value = email.remetenteEmail || '';
    $('#cfg-email-nome').value = email.remetenteNome || '';
    $('#cfg-email-senha').placeholder = email.senhaMascarada
      ? `salva (${email.senhaMascarada}) — deixe em branco para manter`
      : 'deixe em branco para manter';
  } catch {
    /* sem permissao ou sem configuracao: silencioso */
  }
}

$('#btn-salvar-email').addEventListener('click', async () => {
  mostrarAlerta('#email-alerta', '');
  try {
    await api('/api/config/email', {
      method: 'POST',
      body: {
        host: $('#cfg-email-host').value,
        porta: Number($('#cfg-email-porta').value),
        usuario: $('#cfg-email-usuario').value,
        senha: $('#cfg-email-senha').value,
        remetenteEmail: $('#cfg-email-remetente').value,
        remetenteNome: $('#cfg-email-nome').value,
      },
    });
    $('#cfg-email-senha').value = '';
    mostrarAlerta('#email-alerta', 'Configuração salva. Use "Testar conexão" antes de enviar.', 'ok');
    estado.meta = await api('/api/meta');
  } catch (falha) {
    mostrarAlerta('#email-alerta', falha.message);
  }
});

$('#btn-testar-email').addEventListener('click', async () => {
  mostrarAlerta('#email-alerta', 'Testando...', 'ok');
  try {
    const r = await api('/api/config/email/testar', { method: 'POST' });
    mostrarAlerta('#email-alerta', r.mensagem, 'ok');
  } catch (falha) {
    mostrarAlerta('#email-alerta', falha.message);
  }
});

$('#btn-remover-email').addEventListener('click', async () => {
  if (!confirm('Remover a configuração de e-mail?')) return;
  try {
    await api('/api/config/email', { method: 'DELETE' });
    for (const id of ['#cfg-email-host', '#cfg-email-usuario', '#cfg-email-senha', '#cfg-email-remetente', '#cfg-email-nome']) {
      $(id).value = '';
    }
    mostrarAlerta('#email-alerta', 'Configuração removida.', 'ok');
    estado.meta = await api('/api/meta');
  } catch (falha) {
    mostrarAlerta('#email-alerta', falha.message);
  }
});

// ==========================================================================
// GAVETA DO LEAD — decisores via LinkedIn, e-mail e historico
// ==========================================================================

const ROTULO_CONFIANCA = {
  alta: ['etiqueta-ok', 'confiança alta'],
  media: ['etiqueta-aviso', 'confiança média'],
  baixa: ['etiqueta-risco', 'confiança baixa'],
};

function perfilLinkedin(pessoa, leadId, aoSalvar) {
  const [classe, rotulo] = ROTULO_CONFIANCA[pessoa.confianca] || ROTULO_CONFIANCA.baixa;

  const botao = pessoa.jaSalvo
    ? el('span', { classe: 'etiqueta etiqueta-ok', texto: 'já salvo' })
    : el('button', {
        classe: 'btn btn-secundario btn-mini',
        texto: 'Salvar decisor',
        onclick: async (evento) => {
          evento.target.disabled = true;
          try {
            await api(`/api/leads/${encodeURIComponent(leadId)}/contatos`, {
              method: 'POST',
              body: {
                nomeCompleto: pessoa.nomeCompleto,
                cargo: pessoa.cargo || 'não informado',
                linkedinUrl: pessoa.linkedinUrl,
                fonteUrl: pessoa.fonteUrl,
                fonteTitulo: pessoa.fonteTitulo,
                trechoEvidencia: pessoa.trechoEvidencia,
                statusAtual: pessoa.statusAtual,
                confianca: pessoa.confianca,
              },
            });
            toast(`${pessoa.nomeCompleto} salvo no lead.`, 'ok');
            aoSalvar();
          } catch (falha) {
            evento.target.disabled = false;
            toast(falha.message, 'erro');
          }
        },
      });

  return el('div', { classe: 'perfil-linkedin' }, [
    el('div', {}, [
      el('strong', { texto: pessoa.nomeCompleto }),
      el('span', { classe: `etiqueta ${classe}`, texto: rotulo }),
      pessoa.cargo ? el('div', { texto: pessoa.cargo }) : null,
      pessoa.empresaNoTitulo ? el('div', { classe: 'secundario', texto: pessoa.empresaNoTitulo }) : null,
      el('div', { classe: 'secundario', texto: pessoa.motivoConfianca }),
      linkExterno(pessoa.linkedinUrl, 'ver perfil'),
    ]),
    botao,
  ]);
}

function secaoLinkedin(lead, recarregar) {
  const resultados = el('div', { classe: 'lista-perfis' });

  const buscar = el('button', {
    classe: 'btn btn-secundario btn-bloco',
    texto: 'Buscar decisores no LinkedIn',
    onclick: async (evento) => {
      evento.target.disabled = true;
      evento.target.textContent = 'Buscando...';
      limpar(resultados);
      try {
        const dados = await api(`/api/leads/${encodeURIComponent(lead.id)}/decisores/linkedin`);
        resultados.appendChild(el('p', { classe: 'ajuda ajuda-mini', texto: dados.aviso }));
        for (const pessoa of dados.pessoas) {
          resultados.appendChild(perfilLinkedin(pessoa, lead.id, recarregar));
        }
        if (!dados.pessoas.length) {
          resultados.appendChild(el('p', { classe: 'secundario', texto: 'Nenhum perfil público indexado.' }));
        }
      } catch (falha) {
        resultados.appendChild(el('p', { classe: 'alerta alerta-erro', texto: falha.message }));
      } finally {
        evento.target.disabled = false;
        evento.target.textContent = 'Buscar decisores no LinkedIn';
      }
    },
  });

  return bloco('Decisores no LinkedIn', [
    el('p', {
      classe: 'ajuda ajuda-mini',
      texto:
        'Consulta o índice público de busca restrito a linkedin.com/in. Nada é gravado sem você escolher — confirme o cargo antes de usar numa abordagem.',
    }),
    buscar,
    resultados,
  ]);
}

function secaoEmail(lead, contatos, recarregar) {
  const comEmail = contatos.filter((c) => c.emailPublico);

  if (!estado.meta?.emailConfigurado) {
    return bloco('Enviar e-mail', [
      el('p', { classe: 'ajuda', texto: 'Nenhum servidor SMTP configurado. Peça ao administrador para cadastrar em Configurações.' }),
    ]);
  }
  if (!comEmail.length) {
    return bloco('Enviar e-mail', [
      el('p', {
        classe: 'ajuda',
        texto:
          'Nenhum decisor deste lead tem e-mail público registrado. Só enviamos para endereço que a própria empresa divulgou — o CRM nunca deduz e-mail.',
      }),
    ]);
  }

  const seletor = el('select', { classe: 'campo' },
    comEmail.map((c) => el('option', { value: c.id, texto: `${c.nomeCompleto} — ${c.emailPublico}` })));
  const assunto = el('input', { classe: 'campo', type: 'text', placeholder: 'Assunto' });
  const corpo = el('textarea', { classe: 'campo', rows: '8', placeholder: 'Escreva a abordagem...' });

  if (lead.ganchoAbordagem) {
    assunto.value = `Claves Health — ${lead.empresa?.nome || ''}`.trim();
    corpo.value = `${lead.ganchoAbordagem}\n\n`;
  }

  const alerta = el('p', { classe: 'alerta', hidden: 'hidden' });

  return bloco('Enviar e-mail', [
    el('p', {
      classe: 'ajuda ajuda-mini',
      texto: 'Sai da conta da empresa com Reply-To no seu e-mail — a resposta cai na sua caixa. O envio vira atividade e move o lead para "contatado".',
    }),
    seletor,
    assunto,
    corpo,
    el('button', {
      classe: 'btn btn-primario btn-bloco',
      texto: 'Enviar',
      onclick: async (evento) => {
        alerta.hidden = true;
        evento.target.disabled = true;
        evento.target.textContent = 'Enviando...';
        try {
          await api(`/api/leads/${encodeURIComponent(lead.id)}/email`, {
            method: 'POST',
            body: { contatoId: seletor.value, assunto: assunto.value, corpo: corpo.value },
          });
          toast('E-mail enviado e registrado.', 'ok');
          recarregar();
          carregarKanban();
        } catch (falha) {
          alerta.hidden = false;
          alerta.className = 'alerta alerta-erro';
          alerta.textContent = falha.message;
        } finally {
          evento.target.disabled = false;
          evento.target.textContent = 'Enviar';
        }
      },
    }),
    alerta,
  ]);
}

function secaoAtividades(lead, atividades, recarregar) {
  const tipo = el('select', { classe: 'campo campo-curto' }, [
    el('option', { value: 'ligacao', texto: 'Ligação' }),
    el('option', { value: 'reuniao', texto: 'Reunião' }),
    el('option', { value: 'linkedin', texto: 'LinkedIn' }),
    el('option', { value: 'whatsapp', texto: 'WhatsApp' }),
    el('option', { value: 'nota', texto: 'Nota' }),
  ]);
  const resumo = el('input', { classe: 'campo', type: 'text', placeholder: 'O que aconteceu?' });

  const historico = atividades.length
    ? atividades.map((a) =>
        el('div', { classe: 'atividade' }, [
          el('div', {}, [
            el('span', { classe: 'etiqueta', texto: a.tipo }),
            el('strong', { texto: a.assunto || a.resumo?.slice(0, 80) || '' }),
          ]),
          el('div', { classe: 'secundario', texto: `${a.usuarioNome || '—'} · ${formatarData(a.em)}` }),
          a.assunto && a.resumo ? el('div', { classe: 'secundario', texto: a.resumo.slice(0, 300) }) : null,
        ])
      )
    : [el('p', { classe: 'secundario', texto: 'Nenhum contato registrado ainda.' })];

  return bloco('Histórico de contato', [
    ...historico,
    el('div', { classe: 'linha-botoes' }, [
      tipo,
      resumo,
      el('button', {
        classe: 'btn btn-secundario',
        texto: 'Registrar',
        onclick: async () => {
          if (!resumo.value.trim()) return toast('Descreva o que aconteceu.', 'erro');
          try {
            await api(`/api/leads/${encodeURIComponent(lead.id)}/atividades`, {
              method: 'POST',
              body: { tipo: tipo.value, resumo: resumo.value },
            });
            toast('Atividade registrada.', 'ok');
            recarregar();
            carregarKanban();
          } catch (falha) {
            toast(falha.message, 'erro');
          }
        },
      }),
    ]),
  ]);
}

/**
 * Estende a gaveta existente em vez de reescreve-la: a montagem original do
 * dossie continua responsavel pelo que ja mostrava, e aqui so acrescentamos as
 * acoes novas — logo antes do botao de excluir, que deve seguir por ultimo.
 */
const abrirGavetaBase = abrirGaveta;
abrirGaveta = async function (leadId) {
  await abrirGavetaBase(leadId);

  let dados;
  try {
    dados = await api(`/api/leads/${encodeURIComponent(leadId)}`);
  } catch {
    return;
  }

  const painel = $('#gaveta-painel');
  const recarregar = () => abrirGaveta(leadId);
  const secoes = [
    secaoLinkedin(dados.lead, recarregar),
    secaoEmail(dados.lead, dados.contatos, recarregar),
    secaoAtividades(dados.lead, dados.atividades || [], recarregar),
  ];

  const botaoExcluir = painel.querySelector('.btn-perigo');
  for (const secao of secoes) {
    if (botaoExcluir) painel.insertBefore(secao, botaoExcluir);
    else painel.appendChild(secao);
  }
};

// ==========================================================================
// LIGACAO DAS TELAS NOVAS AO BOOT
// ==========================================================================

estado.equipe = [];

/**
 * Estende a inicializacao com o que depende de permissao: abas visiveis,
 * papeis que a pessoa pode atribuir, kanban e configuracao de e-mail.
 */
const iniciarAppBase = iniciarApp;
iniciarApp = async function () {
  await iniciarAppBase();

  const permissoes = estado.meta?.permissoes || {};

  // Equipe: so quem gerencia pessoas ve a aba.
  $('#aba-equipe').hidden = !permissoes.gerenciarUsuarios;

  // Papeis oferecidos no cadastro dependem de quem esta cadastrando: gestor
  // monta time de SDR, admin cria qualquer papel.
  const seletorPapel = $('#eq-papel');
  limpar(seletorPapel);
  for (const papel of permissoes.papeisQuePodeAtribuir || []) {
    seletorPapel.appendChild(el('option', { value: papel, texto: papel }));
  }
  $('#eq-papel-descricao').textContent = estado.meta?.descricaoPapeis?.[seletorPapel.value] || '';

  // Filtro por SDR no kanban so faz sentido para quem ve o time inteiro.
  $('#kanban-filtro-dono-area').hidden = !permissoes.verTodosLeads;

  // Credenciais e integracoes sao do admin; o restante da aba (trocar senha)
  // continua disponivel para todo mundo.
  if (!permissoes.configurarIntegracoes) {
    const painelConfig = $('#painel-config');
    for (const id of ['#btn-salvar-llm', '#btn-salvar-busca', '#btn-remover-busca', '#btn-salvar-email', '#btn-testar-email', '#btn-remover-email']) {
      const botao = painelConfig.querySelector(id);
      if (botao) botao.disabled = true;
    }
  }

  await carregarEquipe();
  await carregarConfigEmail();
  await carregarKanban();

  // Senha definida por outra pessoa: a troca e obrigatoria e a pessoa precisa
  // ser levada ate ela, nao apenas avisada.
  if (estado.usuario?.trocaSenhaObrigatoria) {
    for (const aba of $$('.aba')) aba.classList.toggle('ativa', aba.dataset.aba === 'config');
    for (const painel of $$('.painel')) painel.hidden = painel.id !== 'painel-config';
    toast('Sua senha foi definida por outra pessoa. Troque agora, no fim desta página.', 'erro');
    $('#senha-atual')?.focus();
  }
};
