import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useDensity } from './useDensity';

describe('useDensity', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-density');
  });

  it('defaults to comfortable', () => {
    const { result } = renderHook(() => useDensity());
    expect(result.current.density).toBe('comfortable');
    expect(document.documentElement.dataset.density).toBe('comfortable');
  });

  it('persists to localStorage on change', () => {
    const { result } = renderHook(() => useDensity());
    act(() => result.current.setDensity('compact'));
    expect(localStorage.getItem('squad.console.density')).toBe('compact');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('toggle flips density', () => {
    const { result } = renderHook(() => useDensity());
    act(() => result.current.toggle());
    expect(result.current.density).toBe('compact');
    act(() => result.current.toggle());
    expect(result.current.density).toBe('comfortable');
  });
});
