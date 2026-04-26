import { Trash2, Plus, Search } from 'lucide-react';
import { useSearch } from '@tanstack/react-router';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Card } from '~/components/Card';
import { CacheHitRing } from '~/components/charts/CacheHitRing';
import { DurationBars } from '~/components/charts/DurationBars';
import { TokenSparkline } from '~/components/charts/TokenSparkline';
import { Field } from '~/components/Field';
import { Input } from '~/components/Input';
import { Kbd } from '~/components/Kbd';
import { Page } from '~/components/Page';
import { Select } from '~/components/Select';
import { IconButton } from '~/components/IconButton';
import { Skeleton } from '~/components/Skeleton';
import { Spinner } from '~/components/Spinner';
import { Tabs } from '~/components/Tabs';
import { Tooltip } from '~/components/Tooltip';
import { useToast } from '~/components/Toast';
import { useConfirm } from '~/components/Confirm';

const sampleRuns = [
  { inputTokens: 12_000, outputTokens: 2_000, durationMs: 14_200 },
  { inputTokens: 8_200, outputTokens: 1_100, durationMs: 9_400 },
  { inputTokens: 15_000, outputTokens: 3_200, durationMs: 22_000 },
];

export function DesignPlayground() {
  const { design } = useSearch({ from: '/__design' });
  const { toast } = useToast();
  const confirm = useConfirm();

  if (design !== '1') {
    return (
      <Page title="Design playground" description="Internal only — add the query param to view.">
        <Callout tone="info">
          Append <Kbd>design=1</Kbd> to the URL to open the internal design playground.
        </Callout>
      </Page>
    );
  }

  return (
    <Page
      title="Design playground"
      description="Internal: every primitive on one page. Visit /__design?design=1."
    >
      <Card header="Buttons">
        <div className="flex flex-wrap gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost" leftIcon={<Plus size={14} />}>
            Ghost
          </Button>
          <Button variant="danger" leftIcon={<Trash2 size={14} />}>
            Danger
          </Button>
          <Button loading>Loading</Button>
          <Button size="sm">Small</Button>
        </div>
      </Card>

      <Card header="Badges">
        <div className="flex flex-wrap gap-2">
          {(['default', 'success', 'warning', 'danger', 'info'] as const).map((t) => (
            <Badge key={t} tone={t} dot>
              {t}
            </Badge>
          ))}
        </div>
      </Card>

      <Card header="Callouts">
        <div className="space-y-2">
          {(['default', 'info', 'success', 'warning', 'danger'] as const).map((t) => (
            <Callout key={t} tone={t} title={`${t} callout`}>
              This is the body of a {t} callout.
            </Callout>
          ))}
        </div>
      </Card>

      <Card header="Inputs">
        <div className="space-y-3">
          <Field label="Name" helper="Lowercase only.">
            {({ id, helperId }) => <Input id={id} aria-describedby={helperId} placeholder="story-id" />}
          </Field>
          <Field label="Search" helper="Optional.">
            {({ id }) => <Input id={id} leftSlot={<Search size={14} />} placeholder="Find issues…" />}
          </Field>
          <Select defaultValue="anthropic">
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google">Google</option>
          </Select>
        </div>
      </Card>

      <Card header="Toast & Confirm">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => toast({ title: 'Saved', tone: 'success' })}>Show toast</Button>
          <Button
            variant="danger"
            onClick={async () => {
              const ok = await confirm({ title: 'Delete?', description: 'This cannot be undone.', tone: 'danger' });
              toast({ title: ok ? 'Confirmed' : 'Cancelled' });
            }}
          >
            Confirm…
          </Button>
        </div>
      </Card>

      <Card header="Tabs / Skeleton / Spinner / Kbd / Tooltip / IconButton">
        <Tabs
          tabs={[
            { id: 'one', label: 'Tab one', panel: <p>Panel one</p> },
            { id: 'two', label: 'Tab two', panel: <Skeleton className="h-9 w-1/2" /> },
          ]}
        />
        <div className="mt-4 flex items-center gap-3">
          <Spinner />
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <Tooltip label="Hello">
            <span className="text-sm">Hover me</span>
          </Tooltip>
          <IconButton icon={<Trash2 size={14} />} label="Trash" />
        </div>
      </Card>

      <Card header="Charts (sample data)">
        <div className="flex flex-wrap items-center gap-6">
          <CacheHitRing ratio={0.74} />
          <div className="min-w-0 flex-1 basis-[min(100%,240px)]">
            <TokenSparkline runs={sampleRuns} />
          </div>
          <div className="min-w-0 flex-1 basis-[min(100%,240px)]">
            <DurationBars runs={sampleRuns} />
          </div>
        </div>
      </Card>
    </Page>
  );
}
