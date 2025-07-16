# Use the lighter Node.js image since we don't need Puppeteer/Chrome
FROM apify/actor-node:22

# Copy just package.json and package-lock.json
COPY --chown=myuser package*.json ./

# Install NPM packages
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy the remaining files
COPY --chown=myuser . ./

# Run without XVFB since we don't need a browser
CMD npm start --silent