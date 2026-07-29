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

---

## O que ele faz

Um botão — **Buscar e captar leads** — dispara um pipeline agêntico de duas
fases, com progresso em tempo real na tela:

**Fase 1 — Descoberta.** O agente varre o [PNCP][pncp] (Portal Nacional de
Contratações Públicas) e a web procurando empresas com a dor do ICP. Sai com
uma lista de candidatas e já descarta o que bate na anti-persona.

**Fase 2 — Aprofundamento.** Cada candidata vira uma investigação isolada
(contexto próprio, sem contaminação cruzada entre empresas). O agente confirma
o tier, comprova os sinais de compra com fonte e data, mede o volume de vagas
abertas e caça os decisores.

O resultado é um dossiê por empresa contendo:

| Campo | O que é |
|---|---|
| **Por que a Claves** | O centro do dossiê: o sinal concreto ligado à dor de reposição em escala |
| **Sinais de compra** | Licitação vencida, expansão, captação, volume de vagas — cada um com URL e data |
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

- **PNCP** — API pública e gratuita, sem cadastro. É o radar do Tier 1: quem
  vence uma licitação de fornecimento de médicos passa a ter dezenas de vagas
  com prazo contratual.
  O agente é instruído a distinguir os dois lados: **o órgão público que abre a
  licitação é anti-persona; a empresa privada que vence é Tier 1.**
- **Web** — busca e leitura de páginas institucionais, vagas, releases e
  perfis públicos.

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
  security/                cripto, sessão, CSRF, rate limit, anti-SSRF
  store/db.js              persistência JSON com escrita atômica
  llm/                     adaptadores: anthropic, openai-compatível, google
  agentes/
    icp.js                 base de conhecimento: Tiers 1-4 + anti-persona
    prompts.js             prompts de descoberta e aprofundamento
    ferramentas.js         ferramentas do agente + esquema do dossiê
    orquestrador.js        pipeline de duas fases e persistência
  fontes/                  PNCP e busca/leitura web
  rotas/                   auth e API
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

[pncp]: https://pncp.gov.br/api/consulta/swagger-ui/index.html
