FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json index.html ./
COPY src ./src
ARG VITE_API_URL=/api
ARG VITE_SOLANA_RPC_URL=http://127.0.0.1:8899
ARG VITE_TOKEN_DECIMALS=9
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SOLANA_RPC_URL=$VITE_SOLANA_RPC_URL
ENV VITE_TOKEN_DECIMALS=$VITE_TOKEN_DECIMALS
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
