import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmProvider, useConfirm } from './Confirm';

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      onClick={async () => {
        const v = await confirm({ title: 'Delete', description: 'Sure?', tone: 'danger' });
        onResult(v);
      }}
    >
      ask
    </button>
  );
}

describe('Confirm', () => {
  it('resolves true when user confirms', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Harness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText('ask'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('resolves false when user cancels', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Harness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText('ask'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });
});
