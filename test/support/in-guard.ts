/**
 * Inside squad-kit's own guard: a story of squad-kit's own code runs these tests there. The system refuses a sandbox inside
 * it ("sandbox_apply: Operation not permitted"), `ps` and `lsof` see no process outside it, and the AI tool's sign-in is
 * hidden, so the tests that need one of those skip there. They still run outside it, on a developer's computer and in CI.
 */
export const inGuard = process.env.SQUAD_KIT_IN_GUARD === '1';
