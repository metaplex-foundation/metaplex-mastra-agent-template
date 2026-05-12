/**
 * Platform-as-a-Service detection. Used to give operators platform-specific
 * guidance when the agent persists new identity to disk — e.g. Railway's
 * filesystem is ephemeral, so the asset address must be promoted to an env
 * var before the next redeploy or the agent loses its on-chain identity.
 *
 * Detection is a best-effort env-var sniff. Each provider injects at least
 * one identifying variable into the runtime environment; we check for the
 * most reliable one first. Order matters when a host injects multiple
 * (e.g. Railway running on top of K8s also has KUBERNETES_SERVICE_HOST set).
 */

export type PaasPlatform =
  | 'railway'
  | 'fly'
  | 'render'
  | 'heroku'
  | 'kubernetes'
  | 'cloud-run'
  | 'unknown';

export interface PaasInfo {
  platform: PaasPlatform;
  /** Human-readable name used in the registration banner. */
  label: string;
  /** Multi-line, copy-pasteable instructions for persisting env vars on this platform. */
  instructions: string;
}

const RAILWAY_INSTRUCTIONS =
  'Open the Railway dashboard → Variables → Add Variable. Paste the line above. ' +
  'Without this step the agent loses its identity on the next redeploy.';

const FLY_INSTRUCTIONS =
  'Run `fly secrets set <line above>` from your local checkout, or add the line to ' +
  'fly.toml under [env]. Without this step the agent loses identity on the next deploy.';

const RENDER_INSTRUCTIONS =
  'Open the Render dashboard for this service → Environment → Add Environment Variable. ' +
  'Paste the line above. Without this step the agent loses identity on the next deploy.';

const HEROKU_INSTRUCTIONS =
  'Run `heroku config:set <line above>` from your local checkout. Without this step the ' +
  'agent loses identity on the next dyno restart.';

const KUBERNETES_INSTRUCTIONS =
  'Add the line above to the Deployment\'s `env:` section (or use a Secret/ConfigMap and ' +
  'reference it via `envFrom:`). Without this the agent loses identity on the next pod restart.';

const CLOUD_RUN_INSTRUCTIONS =
  'Run `gcloud run services update <service> --update-env-vars <line above>` ' +
  '(or set it in the Cloud Run console → Variables & Secrets). Without this the ' +
  'agent loses identity on the next revision.';

const LOCAL_INSTRUCTIONS =
  'Add the line above to your `.env` file (it has been written to agent-state.json already, ' +
  'so local dev will pick it up automatically — but env-only deploys need the line).';

export function detectPaas(env: NodeJS.ProcessEnv = process.env): PaasInfo {
  // Railway: most reliable hint is RAILWAY_PROJECT_ID. Several other
  // RAILWAY_* vars exist (RAILWAY_STATIC_URL, RAILWAY_ENVIRONMENT_NAME,
  // RAILWAY_SERVICE_ID) — any of them is enough.
  if (
    env.RAILWAY_PROJECT_ID ||
    env.RAILWAY_STATIC_URL ||
    env.RAILWAY_ENVIRONMENT_NAME ||
    env.RAILWAY_SERVICE_ID
  ) {
    return { platform: 'railway', label: 'Railway', instructions: RAILWAY_INSTRUCTIONS };
  }
  // Fly.io: FLY_APP_NAME is set on every machine.
  if (env.FLY_APP_NAME) {
    return { platform: 'fly', label: 'Fly.io', instructions: FLY_INSTRUCTIONS };
  }
  // Render: RENDER=true is set on all Render services.
  if (env.RENDER || env.RENDER_SERVICE_ID) {
    return { platform: 'render', label: 'Render', instructions: RENDER_INSTRUCTIONS };
  }
  // Heroku: DYNO is the canonical signal (e.g. "web.1").
  if (env.DYNO || env.HEROKU_APP_ID) {
    return { platform: 'heroku', label: 'Heroku', instructions: HEROKU_INSTRUCTIONS };
  }
  // Cloud Run / Knative sets K_SERVICE. Check BEFORE the generic Kubernetes
  // case: Cloud Run runs on top of K8s and may also expose
  // KUBERNETES_SERVICE_HOST, but the gcloud/console workflow is the right
  // guidance — `kubectl` doesn't apply.
  if (env.K_SERVICE) {
    return { platform: 'cloud-run', label: 'Cloud Run/Knative', instructions: CLOUD_RUN_INSTRUCTIONS };
  }
  // Kubernetes (generic): every pod has KUBERNETES_SERVICE_HOST.
  if (env.KUBERNETES_SERVICE_HOST) {
    return { platform: 'kubernetes', label: 'Kubernetes', instructions: KUBERNETES_INSTRUCTIONS };
  }
  return { platform: 'unknown', label: 'local', instructions: LOCAL_INSTRUCTIONS };
}
