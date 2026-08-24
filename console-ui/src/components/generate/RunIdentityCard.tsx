import { Badge } from '~/components/Badge';
import type { AuthInfoUI, RuntimeInfo } from '~/hooks/useGenerateRun';

/** `subscription · Claude login (macOS Keychain) · oauth`, or `—` for a pre-0.12.0 run record. */
function authSummary(auth: AuthInfoUI | null): string {
  if (!auth) return '—';
  return [auth.mode, auth.credentialHint, auth.apiKeySource].filter(Boolean).join(' · ');
}

export function RunIdentityCard({
  runtime,
  auth = null,
  telemetryPartial,
}: {
  runtime: RuntimeInfo | null;
  auth?: AuthInfoUI | null;
  telemetryPartial?: boolean;
}) {
  if (!runtime) {
    return (
      <div className="mb-4 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--gray-2)] p-4 text-sm text-[var(--color-text-muted)]">
        Waiting for runtime telemetry…
      </div>
    );
  }

  const anth = runtime.providerOptions?.anthropic;
  const effort = anth?.effortByPhase?.draft ?? anth?.effort ?? null;
  const think = anth?.thinking ?? null;

  return (
    <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="muted">{runtime.provider}</Badge>
        <Badge tone="muted">{runtime.runtimeKind}</Badge>
        <span className="font-mono text-[13px] text-[var(--color-text)]">{runtime.model}</span>
        {telemetryPartial ? (
          <Badge tone="warning" data-testid="telemetry-partial-chip">
            telemetry partial
          </Badge>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {effort ? <Badge tone="default">effort: {effort}</Badge> : null}
        {think && think !== 'disabled' && think !== 'off' ? (
          <Badge tone="default">thinking: {think}</Badge>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]" data-testid="run-auth-row">
        <span className="text-[var(--color-text)]">Auth</span> {authSummary(auth)}
      </p>
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
        cache {runtime.cacheEnabled ? 'on' : 'off'} · scout {runtime.scoutEnabled ? 'on' : 'off'} · validation{' '}
        {runtime.validationEnabled ? 'on' : 'off'}
      </p>
    </div>
  );
}
