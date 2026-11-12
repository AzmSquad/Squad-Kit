/**
 * The one plain note on squad-kit's own code (engine/self-project.ts): on the setup, the Overview and Releases. The
 * squad-kit mark says at a glance that this project is squad-kit itself.
 */
export function SelfNote({ title, text }: { title: string; text: string }) {
  return (
    <div className="ob-card selfnote" role="note">
      <img src="/logo.svg" alt="" width={30} height={30} />
      <span className="grow">
        <b>{title}</b>
        <span>{text}</span>
      </span>
    </div>
  );
}
