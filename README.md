# Overlap Time Budgeter

A single-file time-budgeting app: set a daily bank of hours, break it into **fixed blocks** (hours) and **variable allocations** (% of the time left after fixed blocks), then run timers against each and see at a glance whether you're on, near, or over budget. All state lives in the browser's `localStorage`; there is no backend.

Live at <https://timer.godisgood.top>.

## Run locally

Open `index.html` in a browser. That's it — no build step, no server required.

## Run as a container

```bash
docker build -t overlap-budgeter .
docker run --rm -p 8080:80 overlap-budgeter
# open http://localhost:8080
```

## Deploy with ONCE

A prebuilt image is published to GHCR:

```bash
once deploy ghcr.io/razodin137/overlap-budgeter:latest --host <your-domain>
```

ONCE handles kamal-proxy routing and Let's Encrypt TLS automatically.

### Updating a deploy

```bash
once update <your-domain> --image ghcr.io/razodin137/overlap-budgeter:latest
```

## How updates are published

From a host that's logged in to ghcr and has the `once` CLI:

```bash
git add . && git commit -m "..." && git push   # record the change
./deploy.sh                                     # build, push image, roll the deploy
```

`deploy.sh` builds the image, pushes `:latest` and an immutable `:sha-<short>`
to GHCR, and runs `once update` pinned to that `:sha-<short>` (so the pull is
guaranteed). To roll back, point `once update` at a previous `:sha-<short>`:

```bash
once update timer.godisgood.top --image ghcr.io/razodin137/overlap-budgeter:sha-<previous>
```