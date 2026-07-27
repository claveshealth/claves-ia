# Segurança

Este repositório é público. A aplicação foi construída assumindo isso: nenhum
segredo vive no código, e os controles abaixo estão implementados e testados.

## Reportar uma vulnerabilidade

Envie um e-mail para **contato@claves.com.br** com passos de reprodução. Não
abra issue pública para falhas de segurança.

---

## O que nunca vai para o Git

O `.gitignore` bloqueia:

| Caminho | Por quê |
|---|---|
| `.env` | Contém `APP_MASTER_KEY` e a senha do admin inicial |
| `data/` | Contém hashes de senha, leads e as chaves de API cifradas |
| `*.key`, `*.pem`, `secrets/` | Material criptográfico |

Antes do primeiro push, confirme:

```bash
git status --ignored --short | grep -E '\.env$|^.. data/'   # devem estar ignorados
git ls-files | grep -E '^\.env$|^data/'                     # não deve retornar nada
```

---

## Controles implementados

### Segredos em repouso

Chaves de API de LLM e de busca são cifradas com **AES-256-GCM** antes de tocar
o disco:

- IV aleatório de 96 bits por registro;
- **AAD** amarrando o texto cifrado ao ID do registro — um blob cifrado não
  pode ser movido de um provedor para outro;
- a chave de cifragem vem de `APP_MASTER_KEY` (32 bytes), **nunca do código**.

Em produção a aplicação **se recusa a iniciar** sem `APP_MASTER_KEY`. Em
desenvolvimento ela gera uma chave efêmera e avisa no console.

Nenhuma rota devolve a chave em texto puro — apenas a máscara (`sk-a••••••••9999`).

### Autenticação

- Senhas com **scrypt** (N=2^15, r=8, p=1), sal aleatório de 16 bytes, mínimo
  de 12 caracteres.
- Verificação em **tempo constante** (`timingSafeEqual`).
- Login com e-mail inexistente executa um hash descartável, para que o tempo de
  resposta não revele se a conta existe.
- Trocar a senha invalida todas as sessões do usuário.

### Sessões e CSRF

- ID de sessão com 32 bytes aleatórios, **armazenado só em memória** (nunca no
  disco).
- Cookie `HttpOnly`, `SameSite=Strict`, `Secure` quando a `APP_URL` é https.
- Expiração deslizante por inatividade.
- Toda requisição que muda estado passa por **três** verificações: `SameSite`,
  validação de `Origin`/`Referer` e token CSRF double-submit.

### SSRF

Dois pontos aceitam URL vinda de fora: a Base URL customizada do provedor de
LLM e o `ler_pagina` do agente. Ambos passam por `validarUrlExterna`, que:

- exige `https://` e rejeita credenciais embutidas na URL;
- resolve o DNS e **rejeita se qualquer endereço retornado for interno** —
  loopback, RFC1918, CGNAT, multicast, link-local (incluindo
  `169.254.169.254`, o endpoint de metadados de nuvem);
- trata IPv6 corretamente, inclusive **IPv4 mapeado em IPv6** nas duas formas
  (`::ffff:127.0.0.1` e a forma comprimida `::ffff:7f00:1` que o parser de URL
  produz);
- **não segue redirecionamentos automaticamente** — cada salto é revalidado;
- aplica timeout e teto de tamanho de resposta.

### XSS

Os dossiês são escritos por um LLM a partir de páginas da internet, ou seja,
**dado não confiável**. O front-end monta todo o DOM com
`createElement`/`textContent` — não há uma única atribuição de `innerHTML` com
dado da API.

Reforçado por uma CSP sem `unsafe-inline` e sem origens externas:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
```

Não há dependência de CDN — todo asset é servido pela própria aplicação.

### Outros

- **Rate limiting**: login (8/15min por IP *e* por conta), API (300/min por IP),
  pesquisas (20/h por usuário), testes de LLM (10/10min).
- **Teto de corpo** de 512 KB por requisição, respondendo `413`.
- **Path traversal**: o caminho estático é resolvido e verificado contra a raiz
  de `public/` antes de qualquer leitura.
- **Injeção de fórmula em CSV**: valores começando com `=`, `+`, `-` ou `@` são
  prefixados na exportação.
- **Erros**: stack traces nunca chegam ao cliente; erros 5xx viram mensagem
  genérica.
- **Superfície de dependências**: uma única dependência de runtime
  (`@anthropic-ai/sdk`). Sem framework web, sem ORM, sem utilitários.
- **Permissões**: `data/` criado com `0700` e o arquivo de dados com `0600`.

---

## Modelo de ameaça — o que *não* está coberto

Seja honesto sobre os limites antes de expor isso na internet:

- **Não há TLS embutido.** Rode atrás de um proxy reverso (Nginx, Caddy,
  Cloudflare) com HTTPS. Sem isso, o cookie de sessão trafega em claro.
- **Não há papéis/permissões.** Todo usuário autenticado é administrador e
  enxerga todos os leads e credenciais.
- **`TRUST_PROXY=true` sem proxy real** permite forjar `X-Forwarded-For` e
  burlar o rate limit por IP. Só habilite atrás de um proxy confiável.
- **Não há MFA** nem política de rotação de senha.
- **Quem tem acesso ao arquivo `data/` mais a `APP_MASTER_KEY`** consegue
  decifrar as chaves de API. Trate ambos como segredo de produção.
- **O agente consome conteúdo da internet.** Os prompts o instruem a tratar
  páginas como evidência, não como instrução, mas prompt injection em página
  externa é um risco residual real. As ferramentas disponíveis são somente de
  leitura e o escopo de escrita se limita ao banco local — o pior caso é um
  dossiê com conteúdo enganoso, não execução de código.

## Recomendações de operação

1. `APP_MASTER_KEY` em um cofre (não em arquivo versionado).
2. Chaves de API de LLM com **escopo e limite de gasto** definidos no provedor.
3. Backup periódico de `data/claves.json`, cifrado.
4. `npm audit` antes de cada deploy.
5. Remova `ADMIN_EMAIL`/`ADMIN_PASSWORD` do `.env` depois do primeiro boot.
