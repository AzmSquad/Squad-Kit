import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from './Field';

describe('Field', () => {
  it('connects label htmlFor to the rendered input id', () => {
    render(
      <Field label="Title" helper="Required">
        {({ id, helperId }) => <input id={id} aria-describedby={helperId} />}
      </Field>,
    );
    const label = screen.getByText('Title') as HTMLLabelElement;
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(label.htmlFor).toBe(input.id);
  });

  it('shows error in place of helper when both are passed', () => {
    render(
      <Field label="Title" helper="Required" error="Too short">
        {({ id }) => <input id={id} />}
      </Field>,
    );
    expect(screen.getByText('Too short')).toBeInTheDocument();
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
  });
});
