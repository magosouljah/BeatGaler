#!/bin/bash
# Despliegue REPRODUCIBLE de BeatGaler a AWS: Web + Cloud desde el MISMO commit de git (HEAD), sin editar código en el host.
#   bash scripts/aws/deploy.sh            (requiere AWS CLI con sesión válida; ver docs/operations/DEPLOY-AWS.md)
# Pasos: verifica árbol limpio y push → build Web (mode web, catálogo nativo) con .well-known/source-sha.txt → git archive del
# Cloud → sube ambos a S3 (bucket de deploy) → URLs prefirmadas 1 h → SSM ejecuta deploy/aws/activate-release.sh DE ESE MISMO SHA.
set -euo pipefail
REGION=us-east-2; INSTANCE=i-0053e156e4646e799; BUCKET=beatgaler-deploy-403659231201-1792531883
cd "$(git rev-parse --show-toplevel)"
SHA=$(git rev-parse HEAD); ID=${SHA:0:12}
# Solo cuenta lo versionado: archivos sin seguimiento (notas, capturas) no entran en ningún artefacto.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "STOP: tracked changes not committed" >&2; exit 2; fi
BR=$(git rev-parse --abbrev-ref HEAD)
[ "$(git ls-remote origin "refs/heads/$BR" | cut -c1-40)" = "$SHA" ] || { echo "STOP: HEAD $ID is not pushed to origin/$BR" >&2; exit 3; }
OUT="tmp/aws-deploy/$ID"; rm -rf "$OUT"; mkdir -p "$OUT"

echo "== build Web $ID"
VITE_CATALOG_API_ENABLED=true npm run -s build:web
mkdir -p dist/.well-known; echo "$SHA" > dist/.well-known/source-sha.txt
tar -czf "$OUT/web.tgz" -C dist .

echo "== archive Cloud $ID"
git archive --format=tar.gz -o "$OUT/cloud.tgz" "$SHA" cloud-server deploy/aws package.json
git show "$SHA:deploy/aws/activate-release.sh" > "$OUT/activate-release.sh"

CS=$(sha256sum "$OUT/cloud.tgz" | cut -c1-64); WS=$(sha256sum "$OUT/web.tgz" | cut -c1-64)
aws s3 cp --region $REGION --only-show-errors "$OUT/cloud.tgz" "s3://$BUCKET/releases/$SHA/cloud.tgz"
aws s3 cp --region $REGION --only-show-errors "$OUT/web.tgz" "s3://$BUCKET/releases/$SHA/web.tgz"
CU=$(aws s3 presign --region $REGION --expires-in 3600 "s3://$BUCKET/releases/$SHA/cloud.tgz")
WU=$(aws s3 presign --region $REGION --expires-in 3600 "s3://$BUCKET/releases/$SHA/web.tgz")

echo "== activate on $INSTANCE"
node -e '
const fs = require("fs"); const [f, sha, cu, cs, wu, ws, out] = process.argv.slice(1);
const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
const script = `export SHA=${q(sha)} CLOUD_URL=${q(cu)} CLOUD_SHA256=${q(cs)} WEB_URL=${q(wu)} WEB_SHA256=${q(ws)}\n` + fs.readFileSync(f, "utf8").replace(/\r/g, "");
fs.writeFileSync(out, JSON.stringify({ commands: [script], executionTimeout: ["1800"] }));
' "$OUT/activate-release.sh" "$SHA" "$CU" "$CS" "$WU" "$WS" "$OUT/ssm.json"
CID=$(aws ssm send-command --region $REGION --instance-ids $INSTANCE --document-name AWS-RunShellScript --comment "deploy $ID" --parameters "file://$OUT/ssm.json" --query Command.CommandId --output text)
rm -f "$OUT/ssm.json"
while :; do sleep 5; S=$(aws ssm get-command-invocation --region $REGION --command-id "$CID" --instance-id $INSTANCE --query Status --output text 2>/dev/null || echo Pending); case "$S" in Success|Failed|Cancelled|TimedOut) break;; esac; done
aws ssm get-command-invocation --region $REGION --command-id "$CID" --instance-id $INSTANCE --query "[Status,StandardOutputContent,StandardErrorContent]" --output text | tail -40
[ "$S" = Success ] || { echo "DEPLOY FAILED ($S) — activate-release.sh applies rollback automatically" >&2; exit 9; }
echo "== public checks"
curl -fsS https://api.beatgaler.com/readyz; echo
[ "$(curl -fsS https://beatgaler.com/.well-known/source-sha.txt | tr -d '[:space:]')" = "$SHA" ] && echo "WEB_SOURCE_SHA_OK $SHA"
