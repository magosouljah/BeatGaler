# STEP15 PROJECT >2 MiB isolated proof

Date: 2026-10-17 America/Mexico_City. Worktree: `/mnt/e/777/app/beatvault-step15-wsl`, base HEAD `3a942cd73605abafee2b70eb8938e3db61b962fd` plus the uncommitted CSRF change. This is an isolated Sandbox/Telegram run, not the public production origin or a frozen final SHA.

## Reproduction and fix

- The prior A2 durable attempt reported `commit:project` HTTP 500 after 2,388,496/2,388,496 progress, with a canceled reservation and no beat/PROJECT receipt. Classification was read only before any repeat.
- The public-style local Nginx path at `127.0.0.1:4152/beatgaler-api/transport/project/upload` used the repository's upload settings: request buffering off, 2g maximum body, 30m timeouts. It exposed `CSRF_REQUIRED` behind the prior Vite proxy's EPIPE/500.
- Browser diagnostics captured no token values: the XHR header matched the visible cookie, but did **not** match `sessionStorage`; control requests used the session token. The streaming proxy sometimes converted the early upstream CSRF rejection into 502.
- `webTransportSession.ts` now uses the same session CSRF generation as the credentialed fetch boundary for raw XHR. On an explicit `403 CSRF_REQUIRED`, it restores the session if needed and retries at most once with a changed token. It never replays an arbitrary 403/502. The focused component tests cover divergent cookie/storage, rotation, retry, and refusal to replay unrelated denial (9/9 pass).

## Browser→Cloud→PostgreSQL→Telegram result

The WebdriverIO real browser run on 2026-10-17 finished `1 passing (1m 51.4s)`. Its stdout was:

```json
{"ok":true,"stage":"complete","beatId":"step15-project-gt2mib-c8d0cf4c4b","masterMessageId":12,"projectMessageId":13,"projectBytes":2346700,"projectSha256":"adacc1c04b91434032619c655f069d5b9e59df7e8632f9454de8f1ff9d4113e1","indexMessageId":14,"reloadIndexMessageId":14}
```

The spec measured the 2,346,700 byte fixture hash, imported MASTER and PROJECT via the real Direct/Telegram path, published and reloaded INDEX 14, downloaded PROJECT after reconnect, and checked byte length and SHA-256. The Nginx access log showed PROJECT upload HTTP 200, INDEX publish HTTP 200, and INDEX commit HTTP 200 before WSL restarted.

After the restart, a read-only local PostgreSQL query against `beatgaler_step15_a2` returned:

```text
reservation=COMMITTED,user_match=true
beat=ACTIVE,user_match=true
project_bytes=2346700,message=13,sha=adacc1c04b91434032619c655f069d5b9e59df7e8632f9454de8f1ff9d4113e1,user_match=true
index14_pointer_count=1
```

The restart removed `/tmp/step15-local-a2`, including its disposable result JSON and runtime secrets. This file preserves the sanitized stdout and post-run PostgreSQL proof. The upload gate is proven for this isolated tree, but the public HTTPS deployment and frozen final-SHA gate remain open.
