FROM node:22-slim

# poppler-utils -> pdfimages (embedded images out of PDFs); unzip -> media out
# of Office files (they are zip archives). sharp brings its own libvips binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./

CMD ["node", "index.js"]
