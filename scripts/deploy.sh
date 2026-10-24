#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=${1:?Usage: deploy.sh absolute-root commit-sha archive-sha256}
REVISION=${2:?Missing commit SHA}
EXPECTED=${3:?Missing archive checksum}
[[ "$ROOT" =~ ^/[A-Za-z0-9_./-]+$ && "$ROOT" != / && ! "$ROOT" =~ (^|/)\.\.?(/|$) ]] || { echo 'Invalid deployment directory' >&2; exit 1; }
[[ "$REVISION" =~ ^[a-f0-9]{40}$ && "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid revision/checksum' >&2; exit 1; }
ROOT=$(realpath -e -- "$ROOT")
RELEASE="$ROOT/releases/$REVISION"
[[ -f "$ROOT/.env" && -f "$RELEASE/compose.production.yaml" && -f "$RELEASE/image.tar.gz" ]] || { echo 'Missing server .env or release files' >&2; exit 1; }
for executable in docker flock tar sha256sum; do command -v "$executable" >/dev/null || { echo "Missing $executable" >&2; exit 1; }; done
exec 9>"$ROOT/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
ACTUAL=$(sha256sum "$RELEASE/image.tar.gz")
[[ "${ACTUAL%% *}" == "$EXPECTED" ]] || { echo 'Image checksum mismatch' >&2; exit 1; }
export QUIZ_IMAGE="fe-interview-quiz:git-$REVISION"
docker load --input "$RELEASE/image.tar.gz"
IMAGE_ARCH=$(docker image inspect --format '{{.Architecture}}' "$QUIZ_IMAGE")
case $(uname -m) in x86_64) HOST_ARCH=amd64;; aarch64|arm64) HOST_ARCH=arm64;; *) echo 'Unsupported host architecture' >&2; exit 1;; esac
[[ "$IMAGE_ARCH" == "$HOST_ARCH" ]] || { echo 'Image and server architecture differ' >&2; exit 1; }
compose=(docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" -f "$RELEASE/compose.production.yaml")
# Parse only non-secret metadata inside the already verified Node image.
METADATA=$("${compose[@]}" config --format json | docker run --rm -i --network none --read-only --cap-drop ALL --entrypoint node "$QUIZ_IMAGE" -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{const c=JSON.parse(s);console.log(c.name);console.log(c.volumes.quiz_data.name)})')
PROJECT=$(printf '%s\n' "$METADATA" | sed -n '1p')
VOLUME=$(printf '%s\n' "$METADATA" | sed -n '2p')
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ && "$VOLUME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo 'Invalid Compose project/volume' >&2; exit 1; }
docker volume inspect "$VOLUME" >/dev/null || { echo 'Configured volume does not exist; refusing to create an empty database' >&2; exit 1; }
OLD_LIST=$(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=quiz')
OLD_CONTAINERS=()
if [[ -n "$OLD_LIST" ]]; then mapfile -t OLD_CONTAINERS <<< "$OLD_LIST"; fi
[[ ${#OLD_CONTAINERS[@]} -le 1 ]] || { echo 'Multiple quiz containers found; manual inspection required' >&2; exit 1; }
OLD_ID=${OLD_CONTAINERS[0]:-}
OLD_IMAGE=''
if [[ -n "$OLD_ID" ]]; then
  OLD_VOLUME=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$OLD_ID")
  [[ "$OLD_VOLUME" == "$VOLUME" ]] || { echo 'Existing database mount differs; refusing to change data volume' >&2; exit 1; }
  OLD_IMAGE=$(docker inspect --format '{{.Image}}' "$OLD_ID")
  NETWORK_MODE=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$OLD_ID")
  [[ "$NETWORK_MODE" != host && "$NETWORK_MODE" != none && "$NETWORK_MODE" != container:* ]] || { echo 'Existing network mode requires manual migration; refusing to change it' >&2; exit 1; }
  # Preserve every existing bridge network and its service aliases, including
  # 1Panel/OpenResty proxy networks, in an explicit Compose override.
  docker inspect --format '{{json .NetworkSettings.Networks}}' "$OLD_ID" | docker run --rm -i --network none --read-only --cap-drop ALL --entrypoint node "$QUIZ_IMAGE" -e '
    let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{
      const old=JSON.parse(s),names=Object.keys(old),networks={},service={};
      if(!names.length)throw new Error("No existing network to preserve");
      names.forEach((name,i)=>{
        if(!/^[A-Za-z0-9_.-]+$/.test(name))throw new Error("Unsupported network name");
        const key="preserved_"+i,aliases=(old[name].Aliases||[]).filter(a=>/^[A-Za-z0-9_.-]+$/.test(a));
        networks[key]={external:true,name};service[key]=aliases.length?{aliases}:{};
      });console.log(JSON.stringify({services:{quiz:{networks:service}},networks}));
    })' > "$RELEASE/networks.json"
  compose+=(-f "$RELEASE/networks.json")
fi
while IFS= read -r container; do
  [[ -z "$container" || "$container" == "$OLD_ID" ]] || { echo 'Data volume is used by another running container; refusing live backup' >&2; exit 1; }
done <<< "$(docker ps -q --no-trunc --filter "volume=$VOLUME")"

STOPPED=0
BACKUP_HELPER=''
health(){
  local id=$1 attempts=${QUIZ_HEALTH_ATTEMPTS:-20}
  [[ "$attempts" =~ ^[1-9][0-9]?$ ]] || return 1
  for ((i=0;i<attempts;i++)); do
    if docker exec "$id" node -e 'fetch("http://127.0.0.1:3000/healthz",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}
rollback(){
  local status=$?
  trap - ERR
  set +e
  [[ -z "$BACKUP_HELPER" ]] || docker rm "$BACKUP_HELPER" >/dev/null
  if [[ "$STOPPED" == 1 && -n "$OLD_IMAGE" ]]; then
    echo 'Deployment failed. Restoring previous image with the same data volume.' >&2
    export QUIZ_IMAGE="$OLD_IMAGE"
    "${compose[@]}" up -d --no-build --pull never --force-recreate quiz
    local restored
    restored=$("${compose[@]}" ps -q quiz)
    if [[ -n "$restored" ]] && health "$restored"; then echo 'Previous version restored.' >&2; else echo 'Rollback needs manual attention; database and backups retained.' >&2; fi
  elif [[ "$STOPPED" == 1 ]]; then
    "${compose[@]}" stop quiz
    echo 'First deployment failed; data volume retained.' >&2
  fi
  exit "$status"
}
trap rollback ERR
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$ROOT/backups/$STAMP-$REVISION"
mkdir -p "$BACKUP_DIR/data"
STOPPED=1
if [[ -n "$OLD_ID" ]]; then docker stop --time 30 "$OLD_ID" >/dev/null; fi
# Copy a stopped volume through Docker, so no host volume-path assumptions are needed.
BACKUP_HELPER=$(docker create --network none --read-only --mount "type=volume,source=$VOLUME,target=/app/data,readonly" "$QUIZ_IMAGE")
docker cp "$BACKUP_HELPER:/app/data/." "$BACKUP_DIR/data/"
docker rm "$BACKUP_HELPER" >/dev/null
BACKUP_HELPER=''
tar -czf "$BACKUP_DIR/data.tar.gz" -C "$BACKUP_DIR/data" .
export QUIZ_IMAGE="fe-interview-quiz:git-$REVISION"
"${compose[@]}" up -d --no-build --pull never --force-recreate quiz
NEW_ID=$("${compose[@]}" ps -q quiz)
[[ -n "$NEW_ID" ]]
health "$NEW_ID"
printf '%s\n' "$REVISION" >"$ROOT/.current-release.tmp"
mv "$ROOT/.current-release.tmp" "$ROOT/.current-release"
trap - ERR
rm -f -- "$RELEASE/image.tar.gz"
echo "Deployment healthy: $REVISION. Backup: $BACKUP_DIR/data.tar.gz"
