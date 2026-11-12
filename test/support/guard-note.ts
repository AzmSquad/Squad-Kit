import { inGuard } from './in-guard.js';

/** Once per run: inside squad-kit's own guard, the tests that need a sandbox of their own or other processes skip, and why. */
export default function guardNote(): void {
  if (inGuard) console.info("Inside squad-kit's guard: the tests that start a sandbox of their own, look at other processes or read the AI tool's sign-in skip here (a guard cannot hold a second one). They run outside it.");
}
