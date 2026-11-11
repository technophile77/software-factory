# The agent image (ADR 0015, FR-8). Base pinned by index digest (Gate 1
# review 4); Claude Code 2.1.311 checked against the Agent SDK 0.3.311
# manifest (review 3). The engine builds it with `docker build`; the base
# image digest is passed in so the engine's pin is the only one.
ARG BASE_IMAGE

FROM ${BASE_IMAGE} AS build
ARG TARGETARCH
WORKDIR /build
COPY claude-code/package.json claude-code/package-lock.json ./
# Scripts stay off: the platform package already holds the binary, so the
# wrapper's postinstall isn't needed even here.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY claude-sha256.json verify-claude.cjs ./
RUN case "${TARGETARCH}" in amd64) P=x64 ;; arm64) P=arm64 ;; *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; esac \
 && mkdir -p /out \
 && cp "node_modules/@anthropic-ai/claude-code-linux-${P}/claude" /out/claude \
 && node verify-claude.cjs /out/claude "linux-${P}" \
 && chmod 0555 /out/claude

FROM ${BASE_IMAGE}
# SR-19: no npm or npx in the final image (review 4: bundled npm carries advisories).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
 && rm -f /usr/local/bin/docker-entrypoint.sh
COPY --from=build /out/claude /opt/claude/claude
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT []
CMD ["sleep", "infinity"]
