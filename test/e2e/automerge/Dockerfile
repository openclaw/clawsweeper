ARG AUTOMERGE_E2E_BASE_IMAGE=masonxhuang/clawsweeper-automerge-e2e-base:node24.13.0-bookworm-20260718@sha256:26a4e98237cc595b10166b27fc3e6342e805fed0446602e1960357ef6f82bba2
FROM ${AUTOMERGE_E2E_BASE_IMAGE}

WORKDIR /workspace

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# Docker COPY preserves restrictive source directory modes but assigns root
# ownership. Keep the image runnable by the host UID selected by the wrapper.
RUN chmod -R a+rX /workspace
RUN pnpm run build:repair

CMD ["node", "scripts/e2e/automerge.mjs", "--scenario", "all"]
