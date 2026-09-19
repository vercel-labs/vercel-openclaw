FROM vcr.vercel.com/openclaw-foundation/openclaw/openclaw@sha256:30134c3d1427a06e86060257ae1a7a31e71dd5925459d84dd746d1da25a84a6d
USER root
WORKDIR /tmp/openclaw-codex-e2e
COPY package.json package-lock.json openclaw-poc.tgz ./
COPY finalize.mjs bootstrap.mjs ./image/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {assertNpmPolicySupport} from "./image/bootstrap.mjs"; assertNpmPolicySupport(JSON.parse(execFileSync("npm", ["config", "list", "--json"], {encoding:"utf8"})));' && \
    npm ci --include=optional --no-audit --no-fund --min-release-age=2
RUN node image/finalize.mjs
