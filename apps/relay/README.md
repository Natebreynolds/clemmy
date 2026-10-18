# Clementine mobile relay

A small, zero-dependency TCP relay for off-LAN mobile access. The phone's TLS
session is pinned to its paired desktop and passes through the relay unchanged.
The relay reads ClientHello SNI to select the desktop's live outbound tunnel; it
does not decrypt the phone's requests or responses. The separate desktop-to-relay
registration connection does terminate TLS at the relay.

Routing and live sockets belong to one process and are held in memory. Restarting
the relay drops connections and requires desktops to register again. This service
is not an account database or a subscription gate: registration proves possession
of a desktop certificate key, but does not establish a paid entitlement.

## Configuration

Supply secrets at runtime through the host's secret facility or mounted files.
Never add TLS keys, certificates, environment files or user data to the image.

| Variable | Purpose |
| --- | --- |
| `RELAY_BASE_DOMAIN` | Required SNI suffix, for example `relay.example.com`. Both `tunnel.<base>` and `<pairId>.<base>` must resolve to the same TCP endpoint. |
| `RELAY_TLS_KEY_PEM`, `RELAY_TLS_CERT_PEM` | TLS material for the desktop registration leg. Literal `\n` escapes in inline values are accepted. Keep the certificate consistent with the desktop's configured relay pin. |
| `RELAY_TLS_KEY_FILE`, `RELAY_TLS_CERT_FILE` | Runtime-mounted file alternatives to the inline values. Inline values take precedence. Files must be readable by the nonroot container user. |
| `RELAY_PORT` | Optional relay TCP port. Takes precedence over `PORT`; otherwise the legacy `PORT` setting is retained, falling back to `9400`. |
| `RELAY_HEALTH_PORT` | Optional, separate HTTP health port. Unset leaves the health listener disabled. It must differ from the relay TCP port. |
| `RELAY_DRAIN_TIMEOUT_MS` | Bounded shutdown grace for existing connections; default `20000` milliseconds. Configure the host's SIGTERM grace to exceed this deadline with margin. |

When enabled, `GET /healthz` is a process-liveness observation and `GET /readyz`
reports whether this process accepts new relay connections. Readiness must become
unavailable during draining. Responses contain generic status only, without
pairing IDs, tokens, certificates or user content. A healthy process does not prove
that a particular desktop is connected, that a phone can reach it, or that a
subscription service is available.

## Container

Build with **`apps/relay` as the context**, not the repository root:

```sh
docker build -t clementine-relay:local apps/relay
```

The image uses Node 24 LTS, runs as the `node` user and copies only `server.mjs`.
There is no package installation, shell entrypoint or writable state requirement.
The exec-form command passes shutdown signals directly to Node. `EXPOSE` documents
ports; it neither publishes them nor enables a health listener. Set the runtime
variables explicitly for the chosen host. Keep keys outside the build context even
though `.dockerignore` permits only the runtime and build files.

`node:24-bookworm-slim` follows Node 24 patch updates. For a reproducible release,
resolve an approved official image digest and pass that pinned image as
`--build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<digest>`. Record the resolved
base digest, final image digest, source commit and `server.mjs` SHA-256 together.
This repository does not claim that an image has been built or deployed merely
because these artifacts exist.

## Railway: conditional fit

Railway can host an initial **single replica in one region** through its
[raw TCP proxy](https://docs.railway.com/networking/tcp-proxy). Keep serverless
disabled for this always-on relay. A concrete proposed port layout is:

| Runtime setting | Proposed value |
| --- | --- |
| `PORT` | `8080` |
| `RELAY_PORT` | `9400` |
| `RELAY_HEALTH_PORT` | `8080` |
| Public TCP proxy target | `9400` |
| Deployment healthcheck path | `/readyz` on `PORT` (`8080`) |
| Replicas / regions | One / one |
| Serverless | Off |
| SIGTERM grace | Greater than the configured relay drain timeout, with operational margin; for example 30 seconds for a 20-second drain |

These are future deployment recommendations, **not observed production settings**.
Railway's TCP proxy assigns an external port; a custom DNS CNAME replaces the
hostname but retains that assigned port. Point both required SNI names to the same
endpoint and configure clients with that actual public port. A wildcard DNS record
can cover the pairing subdomains. Cloudflare must be DNS-only. Do not use ordinary
Railway HTTPS ingress to terminate the phone's pinned TLS.

Important limits:

- [TCP load balancing](https://docs.railway.com/networking/tcp-proxy) randomly
  distributes connections across replicas in the nearest region. Railway has
  [no sticky sessions](https://docs.railway.com/deployments/scaling). Independent
  phone and desktop connections can reach different in-memory maps. A shared
  database alone cannot move live sockets. More replicas or regions require an
  explicit stable relay-owner routing design first.
- [Overlap and SIGTERM draining](https://docs.railway.com/deployments/deployment-teardown)
  are separate settings; both default to zero seconds in the
  [variable reference](https://docs.railway.com/variables/reference). Overlap does
  not transfer registrations or guarantee uninterrupted mobile connections. A
  clean shutdown and a crash must both recover through desktop registration and
  mobile reconnection. Railway can also initiate mandatory infrastructure
  redeployments, as its [deployment lifecycle](https://docs.railway.com/deployments/reference)
  explains.
- [Healthchecks](https://docs.railway.com/deployments/healthchecks) require an HTTP
  `2xx` response before activation, use the configured `PORT`, and do not provide
  continuous monitoring afterward. Monitor the relay separately. A healthcheck
  on an unrelated account API cannot establish this relay's readiness.
- Official TCP documentation does not establish a client-IP-preservation or
  PROXY-protocol guarantee. The current relay observes `socket.remoteAddress`;
  behind a proxy that may be the proxy's address, so source-address limits are
  availability bounds rather than reliable per-user attribution. Confirm the
  actual transport behavior before claiming otherwise. Do not enable PROXY
  headers unless the relay has an explicitly trusted, bounded parser before its
  TLS ClientHello parser.
- Railway's documented HTTP limits are not a proven raw-TCP lifetime contract.
  Obtain the TCP idle/connection-lifetime guarantees and validate long-lived
  connections. The relay heartbeat is not a substitute for that evidence.
- [Serverless sleep](https://docs.railway.com/deployments/serverless) uses outbound
  inactivity and introduces cold starts. Leave it off. Choose CPU/memory caps
  from measured connection load and monitor encrypted traffic egress.
  [Soft cost alerts](https://docs.railway.com/pricing/cost-control) leave services
  running; a Compute hard limit can take workspace workloads offline. A spend cap
  is not an availability safeguard.

## Release and operational evidence

These local changes have not been deployed. Read-only metadata observed on
October 18, 2026 showed the older relay deployment targeting TCP `9400`, with
serverless off and restart policy `ON_FAILURE` (10 retries). Healthcheck, drain
and overlap settings were unset. Subsequent explicit instance/manifest reads
identified one running instance and one configured replica in `us-west2`.
The last 24 hours' five-minute memory samples were approximately 0.088–0.126 GB;
these quiet-window observations do not establish tested connection capacity.
Read-only SSH did not return a current runtime file hash, so the deployed source
bytes remain unqualified. These observations do not prove end-to-end mobile
acceptance of this patch.

The same project contains a license-named service with no current deployment
(one removed historical deployment), and two PostgreSQL services with active
public TCP proxies. A service name does not prove a working subscription system.
Database network changes require confirming external consumers first; no public
database access or other production setting was changed by this patch.

The runtime now reports its actual source-file SHA-256 and Node version on
startup (`relay_ready`), without keys or user content. Retain that observation
with the deployment/image identity after rollout; a local source hash is not a
replacement for a deployed observation.

## Resource boundaries

Default bounds include 256 registered desktop tunnels, 4096 accepted TCP
connections, 64 unfinished registrations, and 128 phone streams per tunnel.
Pending registered/control writes are bounded per socket and in aggregate
(32 MiB and 8192 pending writes globally). A blocked writer with no successful
write completion for 60 seconds is closed; continuing successful completions
renew that idle budget. Slow phones release the shared tunnel instead of leaving
it paused indefinitely. These are availability limits, not measured capacity or protection
against every denial-of-service attack. Registration still has no customer
enrollment authority; add that separately with account/device ownership.

## Local verification

From the repository root, run the isolated relay and existing client contract
tests (no model, customer runtime or external relay connection):

```sh
node scripts/run-tests-isolated.mjs apps/relay/*.test.mjs src/runtime/mobile-relay.test.ts src/runtime/mobile-relay-health.test.ts
```

Tests use disposable certificate identities and loopback listeners. This local
proof does not certify the public Railway route or a physical phone.

Release qualification is pending until an authorized operator records the actual
service, region, replica count, image/source hashes, public hostname/port,
healthcheck and drain settings. Do not infer these from a local branch or this
example.

Before accepting a relay deployment, use named controlled pairings and retain
sanitized evidence for:

1. **Exact code:** resolve the image digest and source/file hashes; confirm the
   deployed image and configuration match. A successful container start alone is
   not end-to-end acceptance.
2. **Real transport:** connect a phone and desktop from separate networks, verify
   the expected end-to-end certificate pin, SNI routing and assigned external
   port, and exercise the actual streaming/request path. Check observed source
   addresses without retaining user content or credentials.
3. **Restart and failure:** exercise an authorized orderly redeploy, forced loss
   and desktop offline/online cycle. Confirm bounded reconnect, re-registration,
   truthful unavailable/waiting UI, and recovery of a fresh request. Do not claim
   that a restarted relay preserves an already-open socket.
4. **Drain:** readiness stops advertising new work; existing connections receive
   no more than the configured grace; the process exits before the host's kill
   deadline. Check behavior when the phone is still streaming at that deadline.
5. **Capacity and monitoring:** verify connection/admission/backpressure limits
   under controlled load. Monitor liveness, readiness, reconnect failures,
   restarts, memory/CPU, open connections and egress; alert on sustained failures
   and budget growth. Do not log tokens, private keys, raw requests or responses.

These checks require explicit staging/production authorization. Creating this
Dockerfile and guide does not perform them or qualify a deployed service.

## Separate HTTP account/control service

Railway is a reasonable candidate for a separately deployed HTTP account,
subscription and control API with durable state and account-scoped authorization.
That service can scale as a stateless API with a shared database. Keep it separate
from the relay's live socket ownership, health, secret material and release cycle.
Do not treat billing success as authority to change the phone/desktop TLS pinning
or assume the existing relay enforces subscription access.

For future push/status transport, Railway documents
[HTTP duration limits and WebSocket support](https://docs.railway.com/networking/public-networking/specs-and-limits):
HTTP requests have a maximum duration even with traffic; WebSockets are exempt
from those documented duration/inactivity limits. Use resumable, authenticated
delivery rather than assuming an HTTP stream survives every deploy. No account
service, billing integration or provider configuration is implemented here.

## When another host materially helps

- **Fly.io:** consider it if raw TCP on the intended public port and documented
  original-client-address metadata are requirements Railway cannot qualify.
  Fly documents untouched TCP passthrough, dedicated IPv4 for app-owned TLS and
  PROXY protocol v1/v2 in its
  [public networking reference](https://docs.fly.io/networking/services). Adding
  PROXY support still needs relay parsing and a trusted ingress boundary; its TLS
  handler would terminate TLS and is unsuitable for the phone leg. It does not
  solve process-local relay ownership automatically.
- **AWS Network Load Balancer:** consider it if explicit client-IP preservation,
  TCP timeout controls and managed TCP ingress justify the operational overhead.
  A [TCP listener on port 443](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-listeners.html)
  passes encrypted traffic through. Supported configurations offer
  [client-IP preservation or PROXY v2](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html),
  with topology-dependent limitations. Its
  [TCP idle timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html)
  is configurable. It also does not solve the pairing-to-live-process routing
  problem for multiple relay targets.
