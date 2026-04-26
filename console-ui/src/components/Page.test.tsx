import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Page } from './Page';

describe('Page', () => {
  it('renders title, description, and actions', () => {
    render(
      <Page title="Stories" description="Plan once, execute cheap." actions={<button>New</button>}>
        body
      </Page>,
    );
    expect(screen.getByRole('heading', { name: 'Stories' })).toBeInTheDocument();
    expect(screen.getByText('Plan once, execute cheap.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});
