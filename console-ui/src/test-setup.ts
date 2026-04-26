import '@testing-library/jest-dom/vitest';

/* Recharts ResponsiveContainer expects ResizeObserver (not in jsdom). */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'open', {
      get() {
        return this.hasAttribute('open');
      },
      configurable: true,
    });
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
  }
}
