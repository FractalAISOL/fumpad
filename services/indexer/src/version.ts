/** What build a service runs, for /health and /v1/status. Railway sets the deployment id; the git sha when the source is a repo (or set `GIT_SHA`). */
const startedAt = Date.now();

export interface ServiceInfo {
  name: string;
  sha: string | null;
  deploymentId: string | null;
  startedAt: number;
}

export function serviceInfo(name: string, env = process.env): ServiceInfo {
  return {
    name,
    sha: env.GIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || null,
    deploymentId: env.RAILWAY_DEPLOYMENT_ID || null,
    startedAt,
  };
}

/** meta key of a service's heartbeat (written by the indexer, read by the API's /v1/status). */
export const heartbeatKey = (name: string) => `service:${name}`;
