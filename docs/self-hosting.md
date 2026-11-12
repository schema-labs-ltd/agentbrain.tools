# Running Agent Brain

Agent Brain is one small service: an OAuth-protected MCP endpoint at `/mcp`, the OAuth endpoints it needs, and a SQLite database. The same code runs in Docker (Node and better-sqlite3) and on Cloudflare Workers (one SQLite-backed Durable Object).

Every deployment needs three settings:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | The HTTPS base URL agents will reach, for example `https://brain.example.com`. Used as the OAuth issuer and resource. |
| `OWNER_EMAIL` | The email for the single owner account. |
| `OWNER_PASSWORD` | The owner's password, at least 12 characters. Changing it and restarting replaces the stored password. The same email and password sign in to the read-only [website](website.md). |

Optional limits (defaults in brackets): `LIMIT_DOCUMENT_BYTES` (65536), `LIMIT_BRAIN_DOCUMENTS` (50), `LIMIT_BRAIN_BYTES` (1048576), `LIMIT_REVISIONS_PER_DOCUMENT` (50), `LIMIT_EVENTS_PER_BRAIN` (1000), `LIMIT_IMAGE_BYTES` (5242880), `LIMIT_BRAIN_IMAGES` (20), `LIMIT_BRAIN_IMAGE_BYTES` (26214400). Images live in the same SQLite database as documents, split into 1 MB chunks.

## Docker

```sh
cp .env.example .env   # set PUBLIC_URL, OWNER_EMAIL, OWNER_PASSWORD
docker compose up -d
curl http://localhost:8787/healthz
```

Data lives in the `agentbrain-data` volume (`/data/agentbrain.db`), so restarts and image upgrades keep brains and OAuth state. To upgrade, pull or rebuild the image and run `docker compose up -d` again; schema migrations run on start.

Remote agents need HTTPS. Put the container behind a reverse proxy that terminates TLS (Caddy, Traefik, nginx or a Cloudflare Tunnel) and set `PUBLIC_URL` to that address.

**Backups:** copy `/data/agentbrain.db` while the container is stopped, or use `sqlite3 agentbrain.db ".backup backup.db"`. A closed brain's content is deleted from the live database immediately but remains in older backups until they expire, so keep backup retention short.

## Cloudflare Workers

`wrangler.jsonc` deploys the Worker with a SQLite-backed Durable Object. Edit `account_id`, `routes` and `PUBLIC_URL` for your own account and domain, then:

```sh
npm ci
npx wrangler secret put OWNER_EMAIL
npx wrangler secret put OWNER_PASSWORD
npx wrangler deploy
```

All state for the instance lives in one Durable Object, which serialises writes and keeps each change transactional. That is plenty for a private instance.

## Checking a deployment

`scripts/smoke.ts` signs two OAuth clients in as the owner, shares a brain between them, forces and resolves an edit conflict, and closes the brain with an export so nothing is left behind:

```sh
AGENTBRAIN_URL=https://brain.example.com OWNER_EMAIL=... OWNER_PASSWORD=... npx tsx scripts/smoke.ts
```

## Connecting agents

See [agent-rule.md](agent-rule.md) for connecting each client and installing the global rule that recognises `agentBrain:` references.
