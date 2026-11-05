import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { PROJECT_BASE } from '../api/client';
import { report } from '../lib/report';

/**
 * A page that broke while drawing itself. The sidebar stays (only the page's own route shows this), nothing the person
 * typed is lost (lib/drafts.ts), and there are always ways on: try again, go to the board, report it.
 */
export function CrashPage({ error, reset }: { error: unknown; reset?(): void }) {
  const words = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return (
    <div className="center" role="alert" style={{ padding: 24 }}>
      <div style={{ maxWidth: 520 }}>
        <h2>
          <TriangleAlert size={18} style={{ verticalAlign: '-3px', marginRight: 8 }} />
          This page ran into a problem
        </h2>
        <p>Your work is safe, and so is what you typed. Try again, or go on from the board.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn pri" onClick={() => (reset ? reset() : window.location.reload())}>Try again</button>
          <a className="btn" href={`${PROJECT_BASE}/board`}>Go to the board</a>
          <button className="btn" onClick={() => report.open({})}>Report a problem</button>
        </div>
        <details style={{ marginTop: 14 }}>
          <summary className="note">For engineers</summary>
          <pre className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{words}</pre>
        </details>
      </div>
    </div>
  );
}

/** The net around what no route holds: the whole page, and the report window. */
export class Boundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return this.props.fallback ?? <CrashPage error={this.state.error} reset={() => this.setState({ error: null })} />;
  }
}
