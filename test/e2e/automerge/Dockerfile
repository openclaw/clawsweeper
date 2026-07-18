ARG AUTOMERGE_E2E_BASE_IMAGE=clawsweeper-automerge-e2e-base:local
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
