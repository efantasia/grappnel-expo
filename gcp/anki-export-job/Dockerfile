FROM node:22-slim

# sharp bundles libvips; adm-zip is pure JS; SQLite is Node's built-in
# node:sqlite (enabled with --experimental-sqlite) — so no apt packages needed.
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js apkg.js ./

CMD ["node", "--experimental-sqlite", "index.js"]
