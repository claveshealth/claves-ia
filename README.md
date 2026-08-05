# Claves CRM IA

CRM de prospecção **B2B** da **Claves Health** com agentes de IA que vasculham a
internet, qualificam empresas contra o ICP (Tiers 1–4), descartam anti-persona
e entregam **quem aprova a compra, com nome completo e cargo comprovados em
fonte pública atual**.

> **O lead é a empresa que contrata a Claves — nunca um médico.**
> Este é um sistema de prospecção comercial, não um banco de candidatos. O
> agente é explicitamente proibido de buscar, qualificar ou registrar médicos,
> currículos e candidatos. Quando encontra uma vaga médica aberta, ela entra
> como **evidência da dor** da empresa que a publicou — e o lead é essa empresa.
> Os "decisores" do dossiê são as pessoas que aprovam a compra de um serviço de
> recrutamento (Diretor de Operações Médicas, Diretor Médico, Head de Gente/RH,
> CEO), não profissionais sendo recrutados.


## Colocar no ar

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/claveshealth/claves-ia)

Um clique. O Render lê o `render.yaml`, provisiona o disco persistente, gera a
chave mestra e descobre a URL pública sozinho. **Você só digita o e-mail e a
senha do primeiro administrador.**

Depois de entrar, cadastre as chaves de LLM, busca e e-mail na própria tela de
Configurações. Passo a passo e solução de problemas em [DEPLOY.md](DEPLOY.md).

---

## O que ele faz

Um botão — **Buscar e captar leads** — dispara um pipeline agêntico de duas
fases, com progresso em tempo real na tela:

**Fase 1 — Descoberta.** O agente varre a web procurando empresas com a dor do
ICP. Sai com uma lista de candidatas e já descarta o que bate na anti-persona.

**Fase 2 — Aprofundamento.** Cada candidata vira uma investigação isolada
(contexto próprio, sem contaminação cruzada entre empresas). O agente confirma
o tier, comprova os sinais de compra com fonte e data, mede o volume de vagas
abertas e caça os decisores.

O resultado é um dossiê por empresa contendo:

| Campo | O que é |
|---|---|
| **Por que a Claves** | O centro do dossiê: o sinal concreto ligado à dor de reposição em escala |
| **Sinais de compra** | Expansão, captação, aquisição, volume de vagas — cada um com URL e data |
| **Decisores** | Nome completo, cargo, LinkedIn, **data da evidência** e trecho literal que comprova o cargo |
| **Vagas abertas** | Título, especialidade, cidade e há quantos dias está aberta |
| **Anti-persona** | Sinalização automática com o código do perfil detectado |
| **Score 0–100** | Prioridade comercial + gancho de abordagem pronto para o SDR |

### Sobre "dados atuais"

Este foi um requisito explícito, e é tratado em três camadas:

1. Cada decisor carrega `dataDaEvidencia` e `statusAtual`
   (`confirmado_atual` / `provavel_atual` / `nao_confirmado` / `saiu_da_empresa`).
2. O prompt instrui o agente a preferir fontes dos últimos 12 meses e a
   registrar o trecho literal que comprova nome + cargo.
3. **Quem está marcado como `saiu_da_empresa` é descartado no servidor** — não
   entra na base de contatos, mesmo que o modelo o devolva.

O agente também é instruído a **nunca deduzir e-mail** (nada de
`nome.sobrenome@empresa.com.br`): só entra contato que a própria empresa
publicou.

---

## Filtro zero — quem pode ser lead

Antes de qualquer tier, uma regra elimina:

> **Só é lead quem contrata médico diretamente**, por vaga CLT/PJ divulgada em
> canal privado (Gupy, Vagas.com, InfoJobs, LinkedIn Jobs, página própria de
> "trabalhe conosco"), **sem edital**. Quem contrata por licitação, edital,
> concurso ou processo seletivo público está **fora**.

O critério não é natureza jurídica — é o **rito de contratação**. Uma
Organização Social (OS/OSS) que gere hospital público é pessoa jurídica de
direito privado, vence licitação e escala corpo clínico; e ainda assim está
fora, porque preenche vaga médica por edital próprio, com taxa de inscrição e
análise de títulos.

Ter um ATS moderno não basta: existe OS publicando vaga de médico no Gupy que
continua eliminada. A régua é como a vaga é provida, não a ferramenta de RH.

---

## Papéis e times

| Papel | O que faz |
|---|---|
| **admin** | Tudo: cria gestor e SDR, configura LLM, busca e e-mail |
| **gestor** | Cadastra e desativa SDR, vê o pipeline inteiro, reatribui leads. Não toca em credenciais |
| **sdr** | Dispara pesquisas e trabalha o próprio kanban |

**O lead encontrado numa pesquisa vai para o kanban de quem apertou o botão.**
SDR vê e mexe apenas nos próprios leads — lead de outro responde `404`, não
`403`, para não revelar que existe. Gestor e admin veem o quadro da equipe, com
o dono em cada cartão e filtro por SDR.

**Esqueci minha senha** funciona sozinho, na tela de login: o CRM envia um link
de uso único, válido por 1 hora. O token nunca é gravado em texto puro — só o
hash — e a resposta da rota é idêntica exista o e-mail ou não, para não revelar
quais endereços têm conta. Precisa de SMTP configurado; sem ele, o caminho é o
gestor redefinir na aba Equipe.

Regras que impedem o sistema de se trancar: ninguém muda o próprio papel, se
desativa ou redefine a própria senha por essa via, e sempre resta ao menos um
admin ativo. Usuário não é apagado, é **desativado** — apagar orfanaria os leads
dos quais ele é dono. Há transferência de carteira para usar antes de tirar
alguém da operação.

---

## E-mail

Uma conta SMTP da empresa envia, com **`Reply-To` do SDR** que disparou — a
resposta cai na caixa de quem está tocando o lead, sem cada SDR precisar
cadastrar credencial própria. Todo envio vira **atividade** no histórico do lead
e move o cartão de "novo" para "contatado".

Só enviamos para e-mail já registrado num contato do lead, e o agente é proibido
de deduzir endereço (nada de `nome.sobrenome@empresa.com.br`) — só entra o que a
própria empresa publicou.

Portas 587 (STARTTLS) e 465 (TLS). Se um servidor de 587 não anunciar STARTTLS,
o envio é abortado em vez de degradar para texto puro. Com Gmail ou Microsoft
365, use **senha de aplicativo**.

> **Não há leitura de caixa de entrada (IMAP).** O CRM envia e registra o que
> enviou; as respostas continuam no e-mail do SDR.

---

## Testes

```bash
npm test
```

Cobrem o que quebra em silêncio: o filtro zero e sua posição no briefing, a
matriz de permissões por papel, o parse de perfil do LinkedIn e a defesa contra
header injection no e-mail. Sem dependência de teste — runner nativo do Node.

---

## Instalação

Requer **Node.js 20+**.

```bash
git clone <seu-repositorio>
cd claves-ia
npm install

# 1. Gere a chave mestra (cifra as chaves de API no banco)
npm run gerar-chave

# 2. Crie o .env
cp .env.example .env
#    cole a APP_MASTER_KEY gerada no passo 1

# 3. Crie o primeiro usuário
npm run criar-usuario

# 4. Suba
npm start
```

Acesse `http://127.0.0.1:3000`, faça login e vá em **Configurações** para
cadastrar a chave de API do LLM.

---

## Provedores de LLM

A plataforma aceita **qualquer API de LLM** — o campo de chave fica em
Configurações e a Base URL é livre.

| Provedor | Busca web | Observação |
|---|---|---|
| **Anthropic (Claude)** | nativa | **Recomendado.** Usa `web_search` e `web_fetch` server-side — pesquisa real sem API de busca extra |
| OpenAI / compatível | externa | OpenRouter, Groq, DeepSeek, Together, Azure, gateway próprio — basta apontar a Base URL |
| Google Gemini | externa | — |

Provedores sem busca nativa precisam de uma chave de busca
(**Brave**, **Serper** ou **Tavily**) em Configurações → Integrações. Sem ela o
agente ficaria cego, então a aplicação **recusa a pesquisa** em vez de deixar o
modelo inventar dossiê.

### Profundidade

| Modo | Esforço | Dossiês | Quando usar |
|---|---|---|---|
| Rápida | `medium` | 3 | Varredura ampla, custo baixo |
| Padrão | `high` | 6 | Uso diário |
| Profunda | `xhigh` | 10 | Investigação máxima antes de uma campanha |

---

## Fontes de dados

- **Web** — busca e leitura de páginas institucionais, vagas, releases e
  notícias.
- **LinkedIn** — busca de decisores restrita a `site:linkedin.com/in` através do
  índice público de um buscador (Serper, Brave ou Tavily). O CRM **não lê o
  linkedin.com**: o site devolve muro de login para requisição sem sessão e
  raspá-lo violaria os termos de uso. O que se consulta é o índice que o
  buscador já rastreou — o mesmo resultado de uma busca no Google, só que com o
  título do perfil separado em nome, cargo e empresa, e com um nível de
  confiança calculado. Índice pode estar defasado: `confiança alta` exige que a
  empresa do título bata com a empresa alvo, e nada é gravado sem alguém
  escolher.

> O **PNCP foi removido**. Ele mapeava licitações públicas — exatamente o
> mercado que o filtro zero exclui.

---

## Segurança

O repositório é público; os segredos não são. Detalhes completos em
[SECURITY.md](SECURITY.md). Resumo:

- Chaves de API **cifradas em repouso** (AES-256-GCM, IV por registro, AAD
  amarrado ao ID). A API nunca devolve a chave — só a máscara.
- Senhas com **scrypt** + sal aleatório e comparação em tempo constante.
- Sessão em cookie **httpOnly + SameSite=Strict**; CSRF em profundidade
  (validação de `Origin` + token double-submit).
- **Proteção anti-SSRF** em toda requisição de saída: bloqueia loopback, redes
  privadas, link-local (169.254.169.254 / metadados de nuvem) e IPv4 mapeado em
  IPv6, com revalidação a cada redirecionamento.
- **CSP restritiva** sem `unsafe-inline` e sem CDN. O front-end monta o DOM via
  `textContent` — dossiê escrito por LLM é dado não confiável e nunca vira HTML.
- Rate limiting em login, API e pesquisas.
- `data/` e `.env` no `.gitignore`; arquivo de dados criado com permissão `0600`.

---

## Estrutura

```
server.js                  roteador HTTP + middlewares de segurança
src/
  config.js                configuração e validação de ambiente
  security/                cripto, sessão, CSRF, rate limit, anti-SSRF, papéis
  store/db.js              persistência JSON com escrita atômica
  llm/                     adaptadores: anthropic, openai-compatível, google
  agentes/
    icp.js                 base de conhecimento: Tiers 1-4 + anti-persona
    prompts.js             prompts de descoberta e aprofundamento
    ferramentas.js         ferramentas do agente + esquema do dossiê
    orquestrador.js        pipeline de duas fases e persistência
  fontes/                  busca/leitura web e busca de decisores no LinkedIn
  lib/smtp.js              cliente SMTP mínimo (sem dependência externa)
  rotas/                   auth, API, equipe e e-mail
public/                    front-end (sem framework, sem CDN)
scripts/                   gerar-chave, criar-usuario
```

**Para ajustar o comportamento comercial, edite `src/agentes/icp.js`.** Ele é a
fonte única dos tiers, sinais de compra, cargos-alvo e anti-persona — o resto
do sistema deriva dali, incluindo a aba **ICP** da interface.

---

## Deploy

Em produção a aplicação exige:

- `APP_MASTER_KEY` definida (o boot falha sem ela);
- `APP_URL` em `https://` (o cookie de sessão é `Secure`);
- `TRUST_PROXY=true` **apenas** se houver um proxy reverso confiável à frente.

Rode atrás de um proxy reverso com TLS. Faça backup de `data/claves.json` — ele
guarda os leads e as chaves cifradas.

---

## Limitações conhecidas

- O armazenamento assume **um único processo** dono do arquivo de dados. Não
  rode duas instâncias sobre o mesmo `data/`.
- A qualidade dos dossiês depende do modelo escolhido e do que está publicado
  publicamente. O agente marca confiança `baixa` e `nao_confirmado` quando a
  evidência é fraca — **trate esses casos como pista, não como fato**.
- Sessões vivem em memória: reiniciar o servidor desloga todos os usuários.

