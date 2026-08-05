# Colocar no ar

Guia de deploy do Claves CRM IA. Leva ~20 minutos.

O que a aplicação é, em termos de infraestrutura: um processo Node que serve
HTTP e guarda tudo num arquivo JSON em `data/`. Não há banco externo, fila nem
cache. Isso torna o deploy simples e impõe **duas regras que não podem ser
quebradas**:

1. **Uma instância só.** O arquivo de dados tem um dono único. Duas instâncias
   sobre o mesmo `data/` corrompem leads e usuários. Não ligue autoscaling.
2. **Disco persistente obrigatório.** Sem volume, cada deploy apaga leads,
   usuários e as chaves de API cifradas. Plataforma com disco efêmero
   (Heroku, Vercel, Cloud Run sem volume) **não serve** sem antes trocar o
   armazenamento.

---

## 1. O que preciso de você

### 1.1 Chaves que a plataforma exige

| Item | Obrigatório | Onde conseguir | Custo |
|---|---|---|---|
| **`APP_MASTER_KEY`** | Gerada sozinha¹ | O Render gera; em VPS: `npm run gerar-chave` | — |
| **Chave de LLM** | Sim | [console.anthropic.com](https://console.anthropic.com) → API Keys | Pago por uso |
| **Chave de busca** | Sim¹ | [serper.dev](https://serper.dev) (Google) | Faixa gratuita inicial |
| **SMTP** | Opcional² | Seu provedor de e-mail | — |

¹ Obrigatória para a **busca de decisores no LinkedIn**, sempre. Se você usar um
LLM sem busca nativa (OpenAI, Gemini), ela também vira requisito para a pesquisa
funcionar. Com Anthropic, a pesquisa usa busca nativa e a chave de busca serve
só ao LinkedIn — mas o LinkedIn foi um pedido seu, então na prática é obrigatória.

² Sem SMTP, tudo funciona menos o botão de enviar e-mail.

### 1.2 Detalhamento

¹ **`APP_MASTER_KEY`** — cifra as chaves de API dentro do banco (AES-256-GCM).
No Render o blueprint usa `generateValue: true`: a chave nasce no provedor e
você não digita nada. Em VPS, gere com `npm run gerar-chave`.

> **Copie o valor para um gerenciador de senhas assim que o serviço subir.**
> Se você perder ou trocar esta chave, todas as chaves de API já salvas viram
> ilegíveis, e um backup do banco fica irrestaurável. Ela não é rotacionável.

**Chave de LLM (Anthropic).** É o motor da pesquisa. Recomendo Anthropic porque
é o único provedor com busca web nativa no servidor — os outros exigem a chave
de busca também. Custo é por uso: uma pesquisa "padrão" gera 6 dossiês e consome
na casa de dezenas de milhares de tokens. Comece com um limite de gasto baixo no
console até calibrar.

**Chave de busca (Serper).** Habilita a busca de decisores no LinkedIn. O Serper
é Google — o que o CRM consulta é o índice público, restrito a
`site:linkedin.com/in`. Alternativas aceitas: Brave e Tavily.

**SMTP.** Precisa de quatro coisas: servidor, porta (587 ou 465), usuário e
senha. Com **Gmail ou Microsoft 365 use senha de aplicativo**, não a senha da
conta — a senha normal é recusada por contas com 2FA.

| Provedor | Servidor | Porta |
|---|---|---|
| Gmail / Workspace | `smtp.gmail.com` | 587 |
| Microsoft 365 | `smtp.office365.com` | 587 |
| Zoho | `smtp.zoho.com` | 587 |

### 1.3 Decisões que preciso de você

- **Domínio.** Opcional. O Render já entrega um `*.onrender.com` com HTTPS e a
  aplicação se configura sozinha para ele. Só decida isto se quiser
  `crm.claves.com.br` — aí você define `APP_URL` com o domínio.
- **E-mail e senha do primeiro admin.** A senha precisa de 12+ caracteres.
- **Quem recebe os 6 leads** da prospecção inicial (e-mail de um SDR cadastrado).

### 1.4 O que você NÃO precisa me mandar

Nada disso deve passar por chat, commit ou issue. As chaves vão direto no painel
do provedor de hospedagem. **Se alguma já foi exposta em algum lugar, revogue e
gere outra antes de subir.**

---

## 2. Deploy no Render (caminho recomendado)

O repositório já traz `render.yaml`.

1. **Merge para `main`.** O `render.yaml` aponta para `main`; se você for
   publicar de outra branch, ajuste o campo `branch`.
2. Em [dashboard.render.com](https://dashboard.render.com) → **New** →
   **Blueprint** → conecte `claveshealth/claves-ia`. O Render lê o `render.yaml`.
3. Confirme o **plano Starter**: o gratuito não tem disco persistente e você
   perderia os dados a cada deploy.
4. Preencha as duas únicas variáveis pedidas:

   | Variável | Valor |
   |---|---|
   | `ADMIN_EMAIL` | seu e-mail |
   | `ADMIN_PASSWORD` | senha forte, 12+ caracteres |

   `APP_MASTER_KEY` é gerada pelo Render. `APP_URL` não precisa ser informada:
   a aplicação lê a `RENDER_EXTERNAL_URL` que o provedor injeta. Só defina
   `APP_URL` se for usar domínio próprio.

5. **Deploy.** Confirme que o disco montou em `/app/data`.
6. Acesse a URL, faça login e **remova `ADMIN_EMAIL` e `ADMIN_PASSWORD` do
   painel** — elas só servem ao primeiro boot e não precisam continuar lá.

### Depois de logar

Vá em **Configurações** e cadastre:
- a chave de LLM (provedor Anthropic, modelo `claude-opus-5`);
- a chave de busca (Serper);
- o SMTP, e clique em **Testar conexão** antes do primeiro disparo.

Depois, no shell do Render, popule o kanban:

```bash
CLAVES_SENHA='senha-forte-aqui' node scripts/criar-usuario.js \
  --email sdr@claves.com.br --nome "Nome do SDR" --papel sdr

node scripts/importar-prospeccao.js --dono sdr@claves.com.br
```

---

## 3. Deploy em VPS

```bash
git clone https://github.com/claveshealth/claves-ia && cd claves-ia
export APP_MASTER_KEY=$(node scripts/gerar-chave.js | tail -1)
export APP_URL=https://crm.claves.com.br
docker compose up -d --build
```

Ponha Caddy ou Nginx na frente com TLS. A aplicação escuta em `127.0.0.1:3000` e
**não termina TLS sozinha**. Caddy resolve certificado sozinho:

```
crm.claves.com.br {
    reverse_proxy 127.0.0.1:3000
}
```

Crie o primeiro usuário dentro do container:

```bash
docker compose exec crm sh -c \
  "CLAVES_SENHA='senha-forte' node scripts/criar-usuario.js --email voce@claves.com.br"
```

---

## 4. Backup

Tudo vive num arquivo. Backup é copiá-lo:

```bash
# Render: Shell do serviço
cat /app/data/claves.json > /tmp/backup.json

# VPS
docker compose exec crm cat /app/data/claves.json > backup-$(date +%F).json
```

> O arquivo contém hashes de senha e **chaves de API cifradas**. Trate o backup
> com o mesmo cuidado de um cofre de senhas. E o backup só é restaurável com a
> mesma `APP_MASTER_KEY` — guarde as duas coisas juntas, em lugares seguros.

Automatize isso antes de a base ter valor. Não há backup embutido.

---

## 5. O que já foi verificado e o que não foi

**Verificado:** as 24 asserções da suíte (`npm test`), incluindo o pipeline de
pesquisa ponta a ponta com LLM simulado e as regras do token de recuperação de
senha; a interface em navegador real (kanban, arrastar entre colunas, permissões
por papel, cadastro de equipe e o fluxo completo de "esqueci minha senha", do
e-mail ao login com a senha nova); o **envio de e-mail contra um servidor SMTP
real** (TLS, AUTH, DATA), com a mensagem inspecionada byte a byte; o
provisionamento por script; e o `npm ci --omit=dev` que a imagem executa.

**Não verificado — teste você na primeira hora:**

1. **A imagem Docker nunca foi construída.** Não havia daemon Docker no ambiente
   onde ela foi escrita. É um Dockerfile simples e o passo mais arriscado
   (`npm ci`) foi validado à parte, mas o primeiro `docker build` é seu.
2. **O e-mail nunca passou por Gmail ou Microsoft 365.** A entrega foi provada
   contra um servidor SMTP real, mas local. Provedores comerciais têm
   autenticação de aplicativo, SPF/DKIM e filtros de reputação que só o seu
   domínio revela. Use **Testar conexão** e mande um e-mail para você mesmo
   antes de disparar para um decisor.
3. **A pesquisa nunca rodou contra uma API de LLM real.** O pipeline foi provado
   com adaptador simulado. A primeira execução real, faça com profundidade
   **rápida** para calibrar custo antes de soltar a equipe.
4. **A busca no LinkedIn nunca consultou o Serper de verdade** — o ambiente de
   desenvolvimento tinha a saída de rede bloqueada. O parser foi testado com
   títulos reais de perfil, mas a integração ponta a ponta é sua primeira vez.
