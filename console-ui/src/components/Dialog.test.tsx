import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { Dialog } from './Dialog';

function Harness({ initial = false }: { initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} title="Hi" onClose={() => setOpen(false)}>
        body
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the title and body when open', () => {
    render(<Harness initial />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Hi')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('closes on ESC when dismissible', () => {
    render(<Harness initial />);
    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('locks body scroll while open and restores on close', () => {
    render(<Harness initial />);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
