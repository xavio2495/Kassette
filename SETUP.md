# SETUP — running Kassette locally

Kassette is four pieces that can be brought up independently:

| | | needs |
|---|---|---|
| **1. The web app** | Next.js frontend + API + local SQLite | nothing but Node and a network connection |
| **2. The contracts** | four Hardhat registries on Coston2 | a funded Coston2 wallet |
| **3. The enclaves** | FCE-A and FCE-B, Docker + Go | Docker, Go, two ngrok accounts, indexer credentials |
| **4. The XRPL leg** | rehearsing a real signed Payment | an XRPL testnet wallet |

**Start at §1.** It costs nothing, touches no chain, needs no keys, and gives you the whole
product to click through against live Coston2 price data. §2–§4 are only needed if you intend
to *redeploy* rather than read the deployed system.

> **Everything here is Coston2 testnet.** No mainnet, no real funds.

---

## Contents

- [0. Prerequisites](#0-prerequisites)
- [1. The web app — start here](#1-the-web-app--start-here)
- [2. The contracts](#2-the-contracts)
- [3. The enclaves (FCE-A and FCE-B)](#3-the-enclaves-fce-a-and-fce-b)
- [4. The XRPL settlement leg](#4-the-xrpl-settlement-leg)
- [5. Data: ingesting real posts](#5-data-ingesting-real-posts)
- [6. Everyday commands](#6-everyday-commands)
- [7. Troubleshooting](#7-troubleshooting)

---

## 0. Prerequisites

For **§1 (the app) you need only Node.** The rest is for §2–§4.

| | version | why |
|---|---|---|
| **Node** | **24+** | `web/lib/db.ts` uses `node:sqlite`, which landed in 22.5. `@types/node` must match the runtime or `next build` fails on the sqlite types. |
| Go | 1.25.1 | the two enclave modules |
| Docker | with Compose v2 | the enclave stacks |
| foundry | `cast`, `forge` | the scaffold's own scripts shell out to them |
| ngrok | v3 CLI | each enclave proxy needs a public hostname |
| Python | 3.10+ | only for §4, Flare's `smart-accounts-cli` |

```bash
git clone https://github.com/xavio2495/Kassette.git && cd Kassette
```

### Secrets

Everything secret lives in **one repo-root `.env`**, which is gitignored.

```bash
cp .env.example .env
```

`.env.example` documents every key, what reads it, and which ones are optional. **None of them
are needed for §1.**

Three you cannot self-serve, so start them early if you are doing §3:

| | where | lead time |
|---|---|---|
| Funded Coston2 wallet | <https://faucet.flare.network/coston2> | minutes |
| **Two** ngrok accounts | free plan allows one reserved domain each; FCE-A and FCE-B need one each | minutes |
| Flare indexer credentials | shared hosted account, requested from Flare | **days** |

---

## 1. The web app — start here

No chain spend, no Docker, no keys.

```bash
cd web
npm install
npm run seed -- --reset     # ~2 min
npm run dev                 # → http://localhost:3000
```

`npm run seed` writes `web/kassette.db` (gitignored). **It needs network**: every price is a
real FTSO anchor feed fetched from Coston2's DA Layer with its Merkle proof, not a fixture.
Expect it to be slow and to log retries — the DA Layer rate-limits without an API key, and
`lib/ftso.ts` backs off rather than failing.

If the seed trips the rate limit repeatedly:

```bash
for i in 1 2 3 4 5 6; do rm -f kassette.db; npm run seed -- --reset && break; sleep 75; done
```

### Or skip the seed entirely

The repo ships a committed snapshot of a fully-populated database — the same file the
deployment serves:

```bash
cp data/demo-snapshot.db kassette.db && npm run dev
```

That gives you real callers, scored calls, price marks and attestations immediately, with no
network calls at all. Use it if the DA Layer is throttling you.

### Verify

```bash
npm test          # 118 unit tests
npm run typecheck # tsc --noEmit
npm run build     # next build
npm run lint

# 59 browser checks over every route. Needs `npm run dev` ALREADY RUNNING, on the port it
# actually bound — Next falls back to 3001 if 3000 is taken.
npm run e2e
E2E_BASE_URL=http://localhost:3001 npm run e2e     # if it bound 3001
```

⚠️ **`npm test` does not type-check.** Only `npm run typecheck` and `npm run build` do. That
gap once let a broken build sit for days, because only vitest was ever run.

---

## 2. The contracts

Four registries, all on Coston2 (chain 114). **They are already deployed** — addresses are in
`contracts/deployments/kassette-coston2.json` and in the README. You only need this section to
deploy your own.

```bash
cd contracts
npm install
npx hardhat compile
npx hardhat test          # 70 tests, no network needed
```

To deploy — needs `address` and `private_key` in the root `.env`, and ~40 C2FLR:

```bash
npx hardhat run scripts/deployMarkRegistry.ts        --network coston2
npx hardhat run scripts/deployAttestationRegistry.ts --network coston2
npx hardhat run scripts/deployExtractionRegistry.ts  --network coston2
npx hardhat run scripts/deployExecutionRegistry.ts   --network coston2
```

⚠️ **The registries bind to an extension id at construction, and it is immutable.** So if you
re-register the enclaves (§3), these must be redeployed. Each script reads its extension id
from the scaffold's `config/extension.env` rather than from a literal, so it picks up new ids
automatically. `deployExtractionRegistry` refuses to deploy if the two ids are equal, or if the
two scaffolds name different `FlareTeeManager`s.

Every other Flare dependency resolves through `FlareContractRegistry` at runtime — `FtsoV2`,
`AssetManagerFXRP`, `MasterAccountController`, `FXRP`. **The only address that may be a literal
is `FlareContractRegistry` itself.** The FCC system contracts are the one documented exception,
isolated to a single config module because they are not yet registered.

---

## 3. The enclaves (FCE-A and FCE-B)

This is the involved part. Budget **half a day** and ~40 C2FLR, and note that it
**re-registers everything** — new extension ids, new `InstructionSender` addresses, new
machines, and therefore redeployed registries (§2).

If you only want the app to work, §1 is enough.

### 3.1 Two scaffold clones, not one

```bash
git clone https://github.com/flare-foundation/fce-extension-scaffold infra/fce-extension-scaffold
git clone https://github.com/flare-foundation/fce-extension-scaffold infra/fce-extension-scaffold-extract

cp tee-extension/fce-source/scaffold-env.example  infra/fce-extension-scaffold/.env
cp tee-extension/fce-extract/scaffold-env.example infra/fce-extension-scaffold-extract/.env
```

⚠️ **Each clone stores exactly one extension identity** (`config/extension.env`, the proxy
TOML, the deployed sender address) and `pre-build.sh` rewrites them in place. One clone cannot
hold two extensions.

Fill in each `.env`: `INITIAL_OWNER`, `DEPLOYMENT_PRIVATE_KEY`, `EXT_PROXY_URL` (your ngrok
reserved domain), and the credential — `SOURCE_API_KEY` for FCE-A, `EXTRACT_API_KEY` for FCE-B.

The port map ships in both `scaffold-env.example` files:

| | FCE-A (source) | FCE-B (extract) |
|---|---|---|
| compose project | `kassette-fce-source` | `kassette-fce-extract` |
| proxy internal | `6703` | `6693` |
| proxy external | **`6704`** | **`6694`** |
| redis | `6385` | `6384` |

⚠️ **Check these collide with nothing on your machine.** A Compose project-name collision
**adopts and replaces another project's containers**.

### 3.2 The proxy TOML — nothing generates it

```bash
cd infra/fce-extension-scaffold/config/proxy
cp extension_proxy.coston2.docker.toml.example extension_proxy.coston2.docker.toml
# fill the [db] block from the root .env: db_url host, database, username, password
```

Repeat for the `-extract` clone.

⚠️ If this file is missing, **Docker creates a directory at the mount path** and the proxy dies
with a rootfs error that reads like a Docker bug.

### 3.3 Do NOT pre-create the Docker network

The base compose declares the network `external: true`, but `docker-compose.coston2.yaml`
overrides it to `external: false` — so compose wants to own it, and a hand-made network fails
with *"incorrect label com.docker.compose.network"*. Let `compose up` create it.

### 3.4 Sync the Go source into the scaffolds

The enclave source lives in `tee-extension/`, tracked in this repo; the scaffolds are working
copies. Sync before every build:

```bash
./tee-extension/fce-source/sync-to-enclave.sh
./tee-extension/fce-extract/sync-to-enclave.sh
./tee-extension/fce-extract/sync-to-enclave.sh --check   # verifies no drift
```

⚠️ **FCE-B's sync copies BOTH Go modules**, because it imports `fce-source/pkg/attest` so that
`ContentHash` has exactly one definition. A drifted copy would not fail loudly — it would
silently make every chained extraction unverifiable.

### 3.5 Tunnel first, then build and register

The hostname goes **on-chain** at registration, so the tunnel must be up and reachable first.

```bash
nohup ./tee-extension/fce-source/start-tunnel.sh > /tmp/fcea-tunnel.log 2>&1 &
./tee-extension/fce-source/start-tunnel.sh --check    # port + hostname agree with the scaffold

cd infra/fce-extension-scaffold
bash ./scripts/pre-build.sh     # deploys InstructionSender, registers the extension — ONE SHOT
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d --build
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml restart ext-proxy
bash ./scripts/post-build.sh    # registers the TEE machine
```

Then the same for `infra/fce-extension-scaffold-extract` with port `6694` and
`NGROK_AUTHTOKEN_2`.

⛔ **`pre-build.sh` has no re-run guard** and mints a new extension id every run. Its pre-flight
compiles `tools/` first and stops before spending gas if the overlay is broken. If registration
fails *after* the deploy step, re-run only `cmd/register-extension` with the address it already
printed — never the whole script.

⛔ **Never run `ngrok config add-authtoken`.** It rewrites `~/.config/ngrok/` in place, which
may hold another project's credentials. Both `start-tunnel.sh` scripts pass `--config` at their
own file and read the token from the root `.env`.

### 3.6 After any restart of `extension-tee`

**The signing key lives in memory.** A restarted enclave mints a *new* `teeId`, and the old one
stays ACTIVE on-chain with a key nobody holds — measured: 4 of 4 instructions routed to the
dead machine and none arrived. So a restart is never just `up -d`:

```bash
# 1. tunnel up   2. containers up
# 3. the proxy caches machineData — restart it or it reports the OLD key
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml restart ext-proxy
# 4. register the new machine
bash ./scripts/post-build.sh
# 5. pause the stranded one. THERE IS NO UNPAUSE.
cd tools && set -a && source ../.env && set +a
go run ./cmd/pause-tee -p http://localhost:6704 \
  -a ../config/coston2/deployed-addresses.json \
  -c https://coston2-api.flare.network/ext/C/rpc -stale -dry-run   # then without -dry-run
```

Health check:

```bash
curl -s localhost:6704/info | python3 -m json.tool | head -20   # FCE-A
curl -s localhost:6694/info | python3 -m json.tool | head -20   # FCE-B
```

### 3.7 Verify the whole design end to end

```bash
cd contracts

# The one command that exercises everything: both enclaves for real, registry accepts.
SEED_DB=1 SOURCE_POST_ID=<a post id> npx hardhat run scripts/proveChain.ts --network coston2

# The safety property, shown as a REVERT: a real FCE-B extraction whose source half was
# signed by a throwaway key is rejected with SourceSignerNotActiveTee.
INSTRUCTION_ID=… SOURCE_RESULT='…' EXT_PROXY_URL=http://localhost:6694 \
  npx hardhat run scripts/verifyChainRejection.ts --network coston2

# FDC Web2Json — authorship, from a credential-free endpoint. ~2 min for the voting round.
SEED_DB=1 SOURCE_POST_ID=<a post id> npx hardhat run scripts/attestPostViaFdc.ts --network coston2
```

`proveChain.ts` needs both stacks up and both machines registered *since their last restart*.
It picks a fresh `callId`, recomputes the content hash and asserts it against what FCE-A signed
before involving FCE-B, and takes ~90s.

⚠️ **Use a fresh `callId` per FCE-B run.** The request cache is keyed `(callId, contentHash)`
with a 10-minute TTL, so re-running with the same id returns the *previous* extraction — which
is correct behaviour and looks exactly like a bug.

Testing the model path without touching an enclave:

```bash
cd tee-extension/fce-extract
EXTRACT_API_KEY=$(grep '^OPENROUTER_API=' ../../.env | cut -d= -f2-) go run ./cmd/checkextract -all
```

---

## 4. The XRPL settlement leg

Flare's own CLI is the reference implementation, and cross-checking against it is how a
wallet-id bug in this repo was found. It is **not** part of the app — it is how you verify the
app's instruction encoding and rehearse a real Payment.

```bash
git clone https://github.com/flare-foundation/smart-accounts-cli.git infra/smart-accounts-cli
cd infra/smart-accounts-cli
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
cp .env.example .env && $EDITOR .env
```

`XRPL_SECRET` is a throwaway testnet seed (`xrpl.wallet.generate_faucet_wallet`);
`FLR_PRIVATE_KEY` is the root `.env` deployer. RPCs are Coston2 and
`s.altnet.rippletest.net`.

```bash
set -a && source .env && set +a
./venv/bin/python smart_accounts.py encode fxrp-redeem --value 1      # expect 0x02f8…
./venv/bin/python smart_accounts.py encode fxrp-redeem --value 1 \
  | ./venv/bin/python smart_accounts.py bridge instruction -
```

**The COPY leg has no CLI command** — direct minting is an XRPL Payment to the Core Vault
address (read it from `GET /api/smart-account?xrpl=…`), **no destination tag, no memo**, for the
amount `directMintingPayment` computes. Measured: 10,200,000 drops → exactly 10.000000 FXRP.

⛔ **Do not use the CLI's `custom register`.** That is the pre-registered variant and its facet
is not deployed on Coston2 — it reverts with `FunctionNotFound`.

---

## 5. Data: ingesting real posts

The seed (§1) produces demo data. To pull real posts you need `x_api` and a model key.

```bash
cd web

# Fetch timelines only, spend no model quota. Banks the posts.
npm run ingest -- --fetch-only

# Classify what's stored. Resumable — every verdict is stamped, so nothing is paid for twice.
npm run ingest -- --extract-pending --provider openrouter --limit 100

# Find new candidate callers by the SHAPE of a call, ranked, with samples to read.
npm run find-callers -- --min 2

# Fold the local database into the committed snapshot the deployment serves.
npm run snapshot
```

⚠️ **Fetching and extracting are separate on purpose.** OpenRouter's free tier is 50 model
calls per **day**; when it runs out mid-run, everything already fetched would be lost if the
two were welded together.

⚠️ **`find-callers` proposes, it does not add.** A human reads the samples and edits
`data/callers.json`, because "posts things that pattern-match a call" is not the same as "is a
caller worth putting on a leaderboard" — and this list attributes trades to real, named people.
The file records which candidates were rejected and why.

Regenerating the README/form figures after editing `components/Diagrams.tsx`:

```bash
npm run build && npm run figures     # → web/public/figures/
```

---

## 6. Everyday commands

```bash
# web/
npm run dev · build · start · lint · typecheck · test · e2e
npm run seed -- --reset          # rebuild the local database from live FTSO
npm run snapshot                 # local db → data/demo-snapshot.db (the deployed dataset)
npm run ingest · find-callers · figures

# contracts/
npx hardhat compile · test
npx hardhat run scripts/<script>.ts --network coston2
npm run lint:sol · format:check

# tee-extension/
go test ./...                              # in either module
./tee-extension/fce-*/sync-to-enclave.sh --check
./tee-extension/fce-*/start-tunnel.sh --check
```

---

## 7. Troubleshooting

| Symptom | Cause |
|---|---|
| `next build` fails on `node:sqlite` types | `@types/node` behind the runtime. Needs 24.x. |
| Frontend says "database not seeded" | `cd web && npm run seed -- --reset`, or copy `data/demo-snapshot.db`. |
| `npm run seed -- --reset` → `disk I/O error` | `next dev` holds the deleted DB open. Stop it, `rm -f kassette.db kassette.db-{shm,wal}`, re-run. |
| Seed stops with `anchor-feeds-with-proof 429` | DA Layer throttle. Raise `SEED_PACE_MS` above 3000. |
| `npm run e2e` fails on the landing page | Wrong port — `next dev` fell back to 3001. Pass `E2E_BASE_URL`. |
| Proxy exits immediately, panic mentions `max_user_connections` | Shared indexer at its connection cap. Retry in a loop; it took 14 attempts once. |
| Proxy exits, `docker logs` shows nothing new | Same cap — the panic goes to the file logger. Run `docker compose up ext-proxy` in the foreground. |
| Proxy dies with a rootfs / "not a directory" error | The proxy TOML is missing and Docker made a directory at its path (§3.2). |
| `network X … incorrect label` | You pre-created the network (§3.3). `docker network rm` it. |
| 404 from `/action/result`, caller polls forever | Instruction went to a stranded machine. Do §3.6. |
| `code hashes do not match` at registration | `MODE` and `SIMULATED_TEE` disagree. 1 + true, or 0 + false. |
| Instruction accepted on-chain, never delivered, no error | OPType/OPCommand mismatch, or a command colliding with a reserved name. `go test ./pkg/opcodes` pins both. |
| Enclave refuses with `422`/`400` from the model | The pinned model rejected the tool schema. `cmd/checkextract` reproduces it outside the enclave. |
| FCE-B refuses with a content-hash mismatch | The text handed to it is not what FCE-A attested. **That is the gate working.** |
| FDC verifier returns 401 | The header is `X-API-KEY`, not `X-apikey`. The placeholder key `00000000-…-0` works. |
| FDC verifier rejects the attestation type | The hex must decode to `Web2Json` — `0x42` is 'B', not 'J'. |
| XRPL Payment succeeds, nothing happens on Flare | Wrong wallet id (must be `0xf8` on Coston2), or a destination tag was attached. |
| `ingest` returns HTTP 402 | twitterapi.io is out of credit. The message says "Unauthorized" but means *unpaid* — add `x_api_2` or recharge. |
| `ingest` stalls on repeated 429s | A per-**day** token cap, not per-minute. The headers report the per-minute window and are misleading; the response body names the real one. |

More detail lives in `claude-docs/` — `ERRORS.md` (every failure mode with its cause),
`RUNBOOK.md` (bring-up scenarios) and `MEMORY.md` (the build log).
