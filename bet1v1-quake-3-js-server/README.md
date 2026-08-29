# Bet1v1 Quake 3 JS server

Place legally obtained `pak0.pk3` through `pak8.pk3` directly in `baseq3`.

Start only the lightweight Q3JS server with:

```sh
docker compose --profile bet1v1-quake-3-js-server up bet1v1-quake-3-js-server
```

The native game server uses UDP port 27960. The browser WebSocket gateway and health endpoint use TCP port 27961. Check readiness with:

```sh
curl -fsS http://localhost:27961/healthz
```

Set `Q3JS_PUBLISH_HOST` to a public IPv4 address or DNS hostname before publishing the server. Set `Q3JS_SECURE=true` only when a TLS reverse proxy serves the gateway over valid WSS.
