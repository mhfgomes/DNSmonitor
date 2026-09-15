# DNS Monitoring & Alerting Platform — Blueprint

## 1. Objetivo

Construir uma aplicação self-hosted capaz de monitorizar grandes quantidades de DNS records.

A aplicação deve permitir:

```text
Monitorizar records
        ↓
Consultar vários resolvers
        ↓
Normalizar respostas
        ↓
Comparar com estado anterior / esperado
        ↓
Aplicar regras
        ↓
Atualizar estado
        ↓
Criar incidente
        ↓
Enviar alertas
        ↓
Guardar histórico
```

Casos principais:

- A mudou de IP
- AAAA mudou
- CNAME mudou
- MX mudou
- TXT/SPF mudou
- Record desapareceu
- NXDOMAIN
- SERVFAIL
- Timeout
- Resolvers não concordam
- Valor diferente do esperado
- TTL anormal
- DNSSEC inválido — futuro

---

## 2. Arquitetura

```text
                         ┌─────────────────────┐
                         │      React UI       │
                         │ Vite + shadcn/ui    │
                         └──────────┬──────────┘
                                    │
                                    │ HTTPS / REST
                                    ▼
                         ┌─────────────────────┐
                         │     Fastify API     │
                         │                     │
                         │ Auth                │
                         │ Monitors            │
                         │ Incidents           │
                         │ Settings            │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │      MariaDB        │
                         └──────────┬──────────┘
                                    │
                     ┌──────────────┴──────────────┐
                     │                             │
                     ▼                             ▼
          ┌─────────────────────┐      ┌─────────────────────┐
          │    DNS Worker       │      │ Notification Worker │
          │                     │      │                     │
          │ Scheduler           │      │ Email               │
          │ DNS queries         │      │ Webhook             │
          │ State evaluation    │      │ Discord             │
          └──────────┬──────────┘      └─────────────────────┘
                     │
         ┌───────────┼──────────────┐
         ▼           ▼              ▼
      1.1.1.1     8.8.8.8        9.9.9.9
     Cloudflare    Google          Quad9
```

No MVP, o notification worker pode estar integrado no próprio worker.

---

## 3. Stack

### Backend

- Node.js
- TypeScript
- Fastify
- pnpm workspace
- MariaDB

### Frontend

- React
- Vite
- shadcn/ui
- TypeScript

### Runtime / Deployment

- Docker
- Docker Compose
- Nginx / Nginx Proxy Manager / Traefik / Caddy

### Futuro

- Redis / BullMQ apenas se necessário
- Prometheus / Grafana
- Remote probes
- Kubernetes agent

---

## 4. Monorepo

```text
dns-monitor/
│
├── apps/
│   │
│   ├── web/
│   │   ├── src/
│   │   │   ├── components/
│   │   │   ├── features/
│   │   │   ├── hooks/
│   │   │   ├── pages/
│   │   │   ├── routes/
│   │   │   └── lib/
│   │   └── package.json
│   │
│   ├── api/
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   ├── routes/
│   │   │   ├── middleware/
│   │   │   ├── plugins/
│   │   │   └── server.ts
│   │   └── package.json
│   │
│   └── worker/
│       ├── src/
│       │   ├── scheduler/
│       │   ├── jobs/
│       │   ├── services/
│       │   └── worker.ts
│       └── package.json
│
├── packages/
│   │
│   ├── database/
│   │   ├── schema/
│   │   ├── migrations/
│   │   └── repositories/
│   │
│   ├── dns-engine/
│   │   ├── resolvers/
│   │   ├── normalize/
│   │   ├── compare/
│   │   └── types/
│   │
│   ├── monitoring/
│   │   ├── evaluator/
│   │   ├── state-machine/
│   │   ├── incidents/
│   │   └── rules/
│   │
│   ├── notifications/
│   │   ├── email/
│   │   ├── webhook/
│   │   └── discord/
│   │
│   ├── validation/
│   │
│   └── shared/
│
├── docker/
│
├── .github/
│   └── workflows/
│
├── docker-compose.yml
├── pnpm-workspace.yaml
├── tsconfig.json
└── package.json
```

---

## 5. Separação de responsabilidades

### `packages/dns-engine`

Só sabe fazer DNS.

Não deve conhecer:

- MariaDB
- Fastify
- React
- Users
- Incidents
- Notifications

Contrato:

```ts
export interface DnsEngine {
  query(input: DnsQueryInput): Promise<DnsQueryResult>;
}
```

Input:

```ts
interface DnsQueryInput {
  hostname: string;
  type: DnsRecordType;
  resolver: ResolverConfig;
  timeoutMs: number;
}
```

Resultado:

```ts
interface DnsQueryResult {
  status: DnsQueryStatus;
  answers: DnsAnswer[];
  latencyMs: number;
  rcode?: string;
  queriedAt: Date;
}
```

---

## 6. DNS Record Types

MVP:

```ts
type DnsRecordType =
  | "A"
  | "AAAA"
  | "CNAME"
  | "MX"
  | "TXT"
  | "NS"
  | "SRV"
  | "CAA"
  | "SOA"
  | "PTR";
```

Futuro:

- DS
- DNSKEY
- RRSIG
- TLSA
- NAPTR
- SVCB
- HTTPS

---

## 7. Monitor

Entidade central da aplicação.

```ts
interface Monitor {
  id: string;
  name: string;
  hostname: string;
  recordType: DnsRecordType;
  mode: MonitorMode;
  expectedValue?: unknown;
  resolverGroupId: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  enabled: boolean;
  nextCheckAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

Modes:

```ts
type MonitorMode =
  | "EXPECTED"
  | "WATCH"
  | "EXISTS"
  | "CONSENSUS";
```

---

## 8. Monitor Modes

### EXPECTED

O record deve corresponder a um valor definido.

```text
api.example.pt
A

expected:
10.20.30.40
```

Se receber:

```text
10.20.30.41
```

gera mismatch.

### WATCH

Guarda o estado atual e alerta quando mudar.

```text
old:
10.20.30.40

new:
10.20.30.41
```

Evento:

```text
VALUE_CHANGED
```

### EXISTS

Apenas verifica se o record existe.

### CONSENSUS

Compara vários resolvers.

```text
Cloudflare → 10.20.30.40
Google     → 10.20.30.40
Quad9      → 10.20.30.41
```

Resultado:

```text
2 / 3 agree
WARNING
```

Config opcional:

```text
consensusThreshold = 0.66
```

---

## 9. Resolvers

Tabela:

```text
resolvers
```

Exemplo:

| name | server | protocol |
|---|---|---|
| Cloudflare | `1.1.1.1` | UDP |
| Google | `8.8.8.8` | UDP |
| Quad9 | `9.9.9.9` | UDP |
| Internal DNS | `10.10.1.10` | UDP |

Protocolos:

```ts
type ResolverProtocol =
  | "UDP"
  | "TCP"
  | "DOH"
  | "DOT";
```

MVP:

- UDP
- TCP

---

## 10. Resolver Groups

Um monitor liga-se a um grupo de resolvers.

Exemplo:

```text
Public DNS

Cloudflare
Google
Quad9
```

Outro:

```text
Internal DNS

DC01
DC02
```

Isto permite monitorizar split DNS.

---

## 11. Database Blueprint

### `monitors`

```text
id                  UUID
name                VARCHAR
hostname            VARCHAR
record_type         VARCHAR
mode                VARCHAR

expected_value      JSON

resolver_group_id   UUID

interval_seconds    INT
timeout_ms          INT

failure_threshold   INT
recovery_threshold  INT

enabled             BOOLEAN

next_check_at       DATETIME
last_check_at       DATETIME

created_at
updated_at
```

Indexes:

```text
next_check_at
enabled
hostname
record_type
resolver_group_id
```

---

## 12. `monitor_states`

Estado atual separado da configuração.

```text
monitor_id

status

current_value JSON

current_hash

consecutive_failures
consecutive_successes

last_success_at
last_failure_at

last_changed_at

active_incident_id
```

Status:

```ts
type MonitorStatus =
  | "UNKNOWN"
  | "HEALTHY"
  | "WARNING"
  | "CRITICAL"
  | "PAUSED";
```

---

## 13. `check_runs`

Cada execução do monitor.

```text
id
monitor_id

started_at
finished_at
duration_ms

status

normalized_value JSON

value_hash

resolver_results JSON

created_at
```

Exemplo:

```json
{
  "cloudflare": {
    "status": "SUCCESS",
    "answers": ["10.20.30.40"],
    "latencyMs": 22
  },
  "google": {
    "status": "SUCCESS",
    "answers": ["10.20.30.40"],
    "latencyMs": 27
  }
}
```

---

## 14. `dns_events`

Checks não são o mesmo que eventos importantes.

```text
id
monitor_id
check_run_id

type

old_value JSON
new_value JSON

metadata JSON

created_at
```

Types:

```text
VALUE_CHANGED
VALUE_MISMATCH
NXDOMAIN
SERVFAIL
TIMEOUT
RESOLVER_DISAGREEMENT
RECOVERED
TTL_CHANGED
```

---

## 15. `incidents`

```text
id
monitor_id

status
severity

reason

opened_at
acknowledged_at
resolved_at

initial_value JSON
current_value JSON

created_at
updated_at
```

Status:

```text
OPEN
ACKNOWLEDGED
RESOLVED
```

---

## 16. `incident_events`

Timeline de incidente:

```text
INCIDENT_OPENED
NOTIFICATION_SENT
VALUE_CHANGED
ACKNOWLEDGED
REMINDER_SENT
RECOVERED
INCIDENT_RESOLVED
```

---

## 17. Normalização

Antes de comparar respostas:

```text
DNS response
      ↓
convert
      ↓
normalize
      ↓
sort
      ↓
canonical JSON
      ↓
hash
```

Exemplo MX.

Input:

```text
20 mx2.example.pt
10 mx1.example.pt
```

Canonical:

```json
[
  {
    "priority": 10,
    "host": "mx1.example.pt"
  },
  {
    "priority": 20,
    "host": "mx2.example.pt"
  }
]
```

Depois:

```ts
hash(canonicalValue);
```

---

## 18. Comparadores por record

Evitar:

```ts
JSON.stringify(a) === JSON.stringify(b)
```

Preferir uma abstraction:

```ts
interface RecordComparator<T> {
  normalize(value: T): T;
  equals(a: T, b: T): boolean;
}
```

Implementações:

```text
compareA()
compareAAAA()
compareMX()
compareTXT()
compareNS()
compareCNAME()
compareSRV()
```

---

## 19. Check Flow

```text
1. Acquire monitor
       ↓
2. Mark execution
       ↓
3. Query resolvers
       ↓
4. Normalize responses
       ↓
5. Calculate consensus
       ↓
6. Evaluate monitor rule
       ↓
7. Update counters
       ↓
8. Determine state
       ↓
9. Create DNS events
       ↓
10. Open/update/close incident
       ↓
11. Queue notifications
       ↓
12. Calculate next_check_at
```

---

## 20. Scheduler

Não usar um `setInterval()` por monitor.

Usar:

```text
next_check_at
```

Worker conceptual:

```ts
while (running) {
  const monitors =
    await repository.claimDueMonitors(100);

  await runWithConcurrency(
    monitors,
    20,
    executeMonitor
  );

  await sleep(500);
}
```

---

## 21. Locking

Para suportar múltiplos workers:

```sql
SELECT ...
FROM monitors
WHERE enabled = 1
AND next_check_at <= NOW()
ORDER BY next_check_at
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

Depois atualizar imediatamente:

```text
next_check_at
```

Assim:

```text
worker-01
worker-02
worker-03
```

não processam o mesmo monitor.

---

## 22. Concorrência

Config global:

```env
WORKER_CONCURRENCY=50
WORKER_BATCH_SIZE=100
```

Cada monitor pode consultar vários resolvers em paralelo.

```text
Monitor
 ├── Cloudflare
 ├── Google
 └── Quad9
```

---

## 23. Timeout

Nunca deixar queries DNS penduradas.

```env
DNS_TIMEOUT_MS=3000
```

O monitor pode sobrescrever este valor.

---

## 24. Máquina de Estados

```text
                failure
                  │
                  ▼
HEALTHY ───────────────► WARNING
                           │
                           │ failureThreshold
                           ▼
                       CRITICAL
                           │
                           │ success
                           ▼
                       RECOVERING
                           │
                           │ recoveryThreshold
                           ▼
                        HEALTHY
```

`RECOVERING` pode ser interno e não aparecer na UI.

Exemplo:

```text
failureThreshold = 3
recoveryThreshold = 2
```

Checks:

```text
10:00 OK
10:01 FAIL
10:02 FAIL
10:03 OK
```

Nunca fica crítico.

Outro cenário:

```text
10:00 OK
10:01 FAIL
10:02 FAIL
10:03 FAIL
```

Resultado:

```text
CRITICAL
INCIDENT OPENED
```

Depois:

```text
10:04 OK
10:05 OK
```

Resultado:

```text
HEALTHY
INCIDENT RESOLVED
```

---

## 25. Alert Rules

Não ligar diretamente:

```text
monitor → email
```

Criar regras.

Exemplo:

```text
Rule:
Production Critical DNS

Conditions:

tag = production
severity = critical

Channels:

email-ops
discord-infra
```

---

## 26. Notification Channels

Tabela:

```text
notification_channels
```

Tipos:

```text
SMTP
WEBHOOK
DISCORD
TELEGRAM
SLACK
TEAMS
GOTIFY
```

MVP:

- SMTP
- Webhook
- Discord

---

## 27. Notification Queue

Mesmo sem Redis, usar uma queue persistente em MariaDB.

Tabela:

```text
notification_jobs
```

Campos:

```text
id

incident_id
channel_id

type

payload JSON

status

attempts
next_attempt_at

last_error

created_at
sent_at
```

Status:

```text
PENDING
PROCESSING
SENT
FAILED
```

Assim uma falha de SMTP não bloqueia o DNS worker.

---

## 28. Retry Strategy

Exemplo:

```text
attempt 1 → imediatamente
attempt 2 → +30 sec
attempt 3 → +2 min
attempt 4 → +10 min
attempt 5 → +30 min
```

---

## 29. API Blueprint

### Monitors

```http
GET /api/v1/monitors
POST /api/v1/monitors

GET /api/v1/monitors/:id
PATCH /api/v1/monitors/:id
DELETE /api/v1/monitors/:id

POST /api/v1/monitors/:id/check
POST /api/v1/monitors/:id/pause
POST /api/v1/monitors/:id/resume
```

### Checks

```http
GET /api/v1/monitors/:id/checks
GET /api/v1/checks/:id
```

### Events

```http
GET /api/v1/monitors/:id/events
```

### Incidents

```http
GET /api/v1/incidents
GET /api/v1/incidents/:id

POST /api/v1/incidents/:id/acknowledge
POST /api/v1/incidents/:id/resolve
```

### Resolvers

```http
GET    /api/v1/resolvers
POST   /api/v1/resolvers
PATCH  /api/v1/resolvers/:id
DELETE /api/v1/resolvers/:id
```

### Resolver Groups

```http
GET    /api/v1/resolver-groups
POST   /api/v1/resolver-groups
PATCH  /api/v1/resolver-groups/:id
DELETE /api/v1/resolver-groups/:id
```

### Notifications

```http
GET  /api/v1/notification-channels
POST /api/v1/notification-channels

POST /api/v1/notification-channels/:id/test
```

---

## 30. Dashboard

```text
┌───────────────────────────────────────────────────────┐
│ DNS Monitoring                                       │
│                                                       │
│  428 monitors                                        │
│                                                       │
│  418 Healthy    6 Warning    4 Critical              │
└───────────────────────────────────────────────────────┘


Critical monitors

Status   Host                 Record    Duration
---------------------------------------------------
●        api.company.pt       A         12m
●        smtp.company.pt      MX        8m
●        vpn.company.pt       A         3m


Recent DNS changes

www.company.pt
10.0.0.12 → 10.0.0.14

2 minutes ago
```

---

## 31. Monitor Page

```text
api.company.pt

A

● Healthy

Current value
────────────────────
193.10.20.30


Expected value
────────────────────
193.10.20.30


Resolvers
────────────────────────────────

Cloudflare     ✓     22 ms
Google         ✓     29 ms
Quad9          ✓     34 ms


History
────────────────────────────────

                  ●
             ● ● ● ● ●
       ● ● ●
────────────────────────────────


Events
────────────────────────────────

10:32   Recovered
10:28   IP mismatch
09:21   Google timeout
```

---

## 32. Create Monitor Wizard

### Step 1

```text
Hostname

api.company.pt

Record Type
A
```

### Step 2

```text
Mode

● Expected
○ Watch
○ Exists
○ Consensus
```

### Step 3

```text
Resolver Group

Public DNS

Interval
60 seconds

Failure threshold
3

Recovery threshold
2
```

---

## 33. Tags

Estrutura:

```text
tags
monitor_tags
```

Exemplo:

```text
production
staging
internal
customer-x
customer-y
critical
web
mail
vpn
```

---

## 34. Bulk Import

CSV:

```csv
hostname,type,mode,expected,interval,tags
api.example.pt,A,EXPECTED,1.2.3.4,60,production
smtp.example.pt,MX,WATCH,,300,mail
www.example.pt,CNAME,EXPECTED,api.example.pt,60,production
```

Endpoints:

```http
POST /api/v1/monitors/import
GET /api/v1/monitors/export
```

---

## 35. Maintenance Windows

Tabela:

```text
maintenance_windows
```

Configuração:

```text
Name
Datacenter maintenance

Starts
22:00

Ends
23:30

Tags
production

Suppress notifications
YES
```

Durante manutenção:

```text
DNS checks              ✓
history                 ✓
incident calculation    ✓
notifications           ✕
```

---

## 36. Configuração

`.env`:

```env
NODE_ENV=production

DATABASE_URL=mysql://dnsmonitor:password@mariadb/dnsmonitor

API_PORT=3000

WORKER_BATCH_SIZE=100
WORKER_CONCURRENCY=50

DEFAULT_CHECK_INTERVAL=60
DEFAULT_DNS_TIMEOUT_MS=3000

CHECK_HISTORY_RETENTION_DAYS=30

LOG_LEVEL=info
```

---

## 37. Docker Compose

Conceito:

```yaml
services:
  web:
    image: dns-monitor-web

  api:
    image: dns-monitor-api

  worker:
    image: dns-monitor-worker

  mariadb:
    image: mariadb
```

Networks:

```text
frontend
backend
```

MariaDB deve ficar apenas acessível na rede backend.

---

## 38. Reverse Proxy

A aplicação deve funcionar atrás de:

- Nginx
- Nginx Proxy Manager
- Traefik
- Caddy

Exemplo:

```text
https://dns.example.pt
```

---

## 39. Health Endpoints

API:

```http
GET /health/live
GET /health/ready
```

Worker:

- Heartbeat persistente na DB

Tabela:

```text
workers
```

Exemplo:

```text
worker-01

status:
online

last_heartbeat:
10:42:12

checks_running:
24
```

---

## 40. Metrics

Preparar desde início:

```text
dns_monitor_checks_total
dns_monitor_checks_failed_total
dns_monitor_query_duration_ms
dns_monitor_incidents_total
dns_monitor_incidents_open
dns_monitor_notifications_total
dns_monitor_notifications_failed
dns_monitor_worker_active_jobs
```

Endpoint:

```http
GET /metrics
```

---

## 41. Logging

Usar logs JSON estruturados.

```json
{
  "level": "info",
  "event": "dns_check",
  "monitorId": "abc",
  "hostname": "api.example.pt",
  "recordType": "A",
  "status": "SUCCESS",
  "durationMs": 42
}
```

Evitar logs vagos como:

```text
DNS check OK
```

---

## 42. Auth

MVP:

```text
Local authentication

email
password
```

Passwords:

```text
Argon2id
```

Futuro:

- OIDC
- Microsoft Entra ID
- Google
- LDAP

---

## 43. Roles

Preparar desde início:

```text
ADMIN
EDITOR
VIEWER
```

| Ação | Admin | Editor | Viewer |
|---|---:|---:|---:|
| View | ✓ | ✓ | ✓ |
| Create monitors | ✓ | ✓ | |
| Edit monitors | ✓ | ✓ | |
| Delete | ✓ | | |
| Settings | ✓ | | |

---

## 44. Retenção

Exemplo:

```text
check_runs
30 days
```

Manter:

```text
dns_events
incidents
```

por mais tempo ou indefinidamente.

Futuro:

```text
raw checks
30 days

hourly statistics
1 year
```

---

## 45. Segurança

Não expor publicamente:

- MariaDB
- Worker
- Internal metrics

Secrets:

- SMTP passwords
- Webhook URLs
- API tokens

Devem estar encrypted at rest.

Exemplo:

```text
AES-256-GCM
```

Master key:

```env
ENCRYPTION_KEY=
```

---

## 46. Testes

Estrutura:

```text
Unit tests
    ↓
Integration tests
    ↓
DNS simulation
    ↓
API tests
    ↓
E2E
```

Testar especialmente:

- Normalização MX
- Normalização TXT
- Ordering
- CNAME trailing dot
- Case-insensitive hostnames
- NXDOMAIN
- SERVFAIL
- Timeout
- Resolver disagreement
- State transition
- Flapping
- Notification deduplication

---

## 47. DNS Test Server

Criar um pequeno fake DNS server para CI e testes.

Exemplo:

```text
test.example
A
1.2.3.4
```

Depois alterar programaticamente para:

```text
5.6.7.8
```

Permite testar mudanças de records sem depender da Internet.

---

## 48. CI/CD

GitHub Actions:

```text
install
    ↓
lint
    ↓
typecheck
    ↓
unit tests
    ↓
integration tests
    ↓
build
    ↓
docker build
```

Branches sugeridos:

```text
main
feature/*
```

Ou, se preferido:

```text
main
develop
feature/*
```

---

## 49. Ordem de Implementação

```text
1. packages/shared

2. packages/database

3. packages/dns-engine

4. packages/monitoring

5. apps/worker

6. apps/api

7. apps/web

8. packages/notifications
```

Não começar pela UI.

---

## 50. Milestones

### Milestone 0.1

Objetivo:

```text
Adicionar monitor na DB
        ↓
worker encontra monitor
        ↓
faz DNS query
        ↓
guarda resultado
        ↓
calcula next_check_at
```

Suporte inicial:

```text
A
AAAA
CNAME
```

Sem UI.

### Milestone 0.2

Adicionar:

```text
normalization
EXPECTED
WATCH
monitor_states
```

Resultado:

```text
✓ Healthy
✕ Mismatch
⚠ Changed
```

### Milestone 0.3

Adicionar:

```text
failureThreshold
recoveryThreshold
incidents
```

### Milestone 0.4

Adicionar:

```text
notification queue
SMTP
Webhook
Discord
```

### Milestone 0.5

Construir API:

```text
monitors
checks
events
incidents
resolvers
notifications
```

### Milestone 0.6

Construir React UI:

```text
Dashboard
Monitor list
Monitor details
Create/Edit
Incidents
Settings
```

Neste ponto existe um MVP utilizável em produção.

---

## 51. Versão 1.0

### DNS

- A
- AAAA
- CNAME
- MX
- NS
- TXT
- SRV
- CAA
- SOA

### Monitoring

- Expected
- Watch
- Exists
- Consensus

### Resolvers

- Custom resolvers
- Resolver groups
- Multi-resolver

### Alerting

- Incidents
- Acknowledgement
- Recovery
- Email
- Webhook
- Discord

### Management

- Tags
- Bulk import
- Maintenance windows

### Operations

- Docker
- Health endpoints
- Metrics
- Retention

---

## 52. Depois do 1.0

Adicionar uma segunda família de funcionalidades:

```text
Domain Monitoring
```

Exemplo:

```text
example.pt
│
├── DNS
│   ├── A
│   ├── MX
│   ├── NS
│   └── TXT
│
├── Delegation
│
├── DNSSEC
│
├── Domain expiry
│
├── TLS certificate
│
└── Nameserver health
```

A aplicação passa então de simples DNS alerts para uma plataforma de DNS/domain observability.

---

## 53. Blueprint Final

```text
                        DNS MONITOR
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
     MONITORS            INCIDENTS            SETTINGS
        │                    │                    │
        │                    │                    │
 ┌──────┴──────┐      ┌──────┴─────┐      ┌──────┴───────┐
 │             │      │            │      │              │
Records     Resolver  Open       Resolved Resolvers   Alerts
 │          Groups    │            │      │              │
 │                    │            │      │              │
 └─────────────┬──────┴────────────┴──────┴──────────────┘
               │
               ▼
           DNS WORKER
               │
      ┌────────┼─────────┐
      │        │         │
      ▼        ▼         ▼
   Query    Normalize   Compare
      │        │         │
      └────────┼─────────┘
               ▼
            Evaluate
               │
               ▼
          State Machine
               │
         ┌─────┴──────┐
         ▼            ▼
      Healthy       Incident
                        │
                        ▼
                  Notifications
```

---

## 54. Princípio Arquitetural Principal

O core do projeto deve ser:

```text
packages/dns-engine
        +
packages/monitoring
```

e não:

```text
apps/api
```

A API e a UI são interfaces.

Se o core estiver bem isolado, futuramente poderá ser reutilizado por:

```text
Web UI
CLI
REST API
Docker agent
Remote probes
Kubernetes agent
```

A primeira implementação deve começar por:

```text
packages/dns-engine
```

com:

```ts
query()
normalize()
compare()
hash()
```

e depois:

```text
packages/monitoring
```

com:

```ts
evaluate()
transitionState()
processIncident()
```

Esta divisão deve ser considerada a base arquitetural do projeto.
