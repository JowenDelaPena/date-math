# Local (stdio) Date Math MCP server: the npm package in npm/, which forwards to the hosted server.
# Used by MCP directories that build and run servers in containers (e.g. Glama).
#   docker build -t date-math-mcp .
#   docker run -i --rm date-math-mcp
# Optional: -e DATE_MATH_PRIVATE_KEY=0x... to pay $0.001 per call after the 25 free daily calls.
FROM node:22-alpine
WORKDIR /app
COPY npm/package.json npm/package-lock.json npm/index.js ./
RUN npm ci --omit=dev --no-audit --no-fund
USER node
ENTRYPOINT ["node", "index.js"]
