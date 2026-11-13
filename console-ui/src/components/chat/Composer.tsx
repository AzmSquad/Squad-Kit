import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ArrowUp, Eye, Mic, Paperclip, Plus, Square, X } from 'lucide-react';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { usePrefs } from '../../lib/prefs';
import { BoxLine, type BoxAsk } from '../decide/BoxAsk';
import { detect, langLabel, textClass } from '../../lib/lang';
import { readFile, type PickedFile } from '../dialogs';
import { AGENT_TITLE, type ChatSize } from './parts';
import type { Pending } from './Sending';

/* ── Typing box ────────────────────────────────────────── */

const MAX_FILE = 10 * 1024 * 1024;

/**
 * The typing box turns to the language you write in, as you type. Files come by the clip, a paste or a drop; a voice
 * note by the microphone. While the agent answers, Send becomes Stop. After "Something's wrong" on the decision card,
 * the box asks for what is wrong and sends it to the board, not to the agent.
 */
export function Composer({
  t,
  size,
  text,
  setText,
  input,
  onSent,
  sendRef,
  setPending,
  box,
  onBoxCancel,
}: {
  t: Ticket;
  size: ChatSize;
  text: string;
  setText(v: string): void;
  input: RefObject<HTMLTextAreaElement>;
  onSent(): void;
  sendRef: { current: ((words: string) => void) | null };
  setPending(p: Pending | null): void;
  box?: BoxAsk | null;
  onBoxCancel?(): void;
}) {
  const act = useAct();
  const { toast } = usePrefs();
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const d = detect(text);
  const label = langLabel(d);
  const rows = Math.min(6, Math.max(1, text.split('\n').length));

  const add = async (list: FileList | File[]) => {
    const picked = [...list];
    const big = picked.find((f) => f.size > MAX_FILE);
    if (big) toast(`${big.name} is larger than 10 MB.`, 'err');
    const read = await Promise.all(picked.filter((f) => f.size <= MAX_FILE).slice(0, 10).map(readFile)).catch((err: Error) => {
      toast(err.message, 'err');
      return [];
    });
    setFiles((now) => [...now, ...read].slice(0, 10));
  };
  // The send button gives a small push when it sends.
  const [went, setWent] = useState(false);
  const pushed = () => {
    setWent(true);
    setTimeout(() => setWent(false), 220);
  };
  const send = (words = text, extra: PickedFile[] = []) => {
    if (box) {
      if (!words.trim()) return;
      pushed();
      box.send(words.trim());
      setText('');
      return;
    }
    const all = [...files, ...extra];
    if ((!words.trim() && !all.length) || c.thinking || act.isPending) return;
    // The message shows as sending in the talk at once; the typing box is free again. On a failure it comes back.
    setPending({ text: words, files: all, count: c.messages.length });
    pushed();
    const typed = text;
    setText('');
    setFiles([]);
    onSent();
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/chat/send`, body: { text: words, files: all.map(({ name, data }) => ({ name, data })) } },
      {
        onError: () => {
          setPending(null);
          setText(typed);
          setFiles(all.filter((f) => !extra.includes(f)));
        },
      },
    );
  };
  sendRef.current = (o: string) => send(o);
  const stop = () => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/stop` });
  const placeholder = box ? box.placeholder : size === 'phone' ? `Message the ${who}` : size === 'pop' ? `Answer the ${who}, or ask it something…` : `Message the ${who} in Arabic or English`;

  return (
    <div
      className="ccomp"
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={() => setDrag(false)}
      onDrop={(e: DragEvent) => (e.preventDefault(), setDrag(false), void add(e.dataTransfer.files))}
    >
      {drag && <div className="cdrop">Drop files to add them to your message</div>}
      {box && <BoxLine box={box} onCancel={() => onBoxCancel?.()} />}
      <Recorder
        who={who}
        size={size}
        onDone={(f) => send(text, [f])}
        render={(rec) =>
          rec.on ? (
            rec.box
          ) : (
            <div className={`cbox ${size === 'phone' ? 'm' : ''} ${box ? 'asking' : ''}`}>
              {files.length > 0 && (
                <div className="cpicked">
                  {files.map((f, i) => (
                    <span key={i} className="chip">
                      {f.preview ? <img src={f.preview} alt="" /> : <Paperclip size={12} />} {f.name}
                      <button className="iconbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}>
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {size === 'phone' && (
                <button className="ib" aria-label="Add screenshots or files" onClick={() => fileInput.current?.click()}>
                  <Plus size={20} />
                </button>
              )}
              <textarea
                ref={input}
                className={`cta ${text ? textClass(d) : 't-en'}`}
                dir={text ? d.dir : 'auto'}
                lang={d.dir === 'rtl' ? 'ar' : 'en'}
                rows={rows}
                value={text}
                placeholder={placeholder}
                aria-label="Your message"
                onChange={(e) => setText(e.target.value)}
                onPaste={(e: ClipboardEvent) => {
                  const pics = [...e.clipboardData.files];
                  if (pics.length) void add(pics);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              {size === 'phone' ? (
                c.thinking ? (
                  <button className="csend m stop" onClick={stop} aria-label="Stop the answer">
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : text.trim() || files.length ? (
                  <button className={`csend m ${went ? 'go' : ''}`} onClick={() => send()} aria-label="Send" disabled={act.isPending}>
                    <ArrowUp size={18} />
                  </button>
                ) : (
                  <button className="csend m mic" onClick={rec.start} aria-label="Record a voice note">
                    <Mic size={18} />
                  </button>
                )
              ) : (
                <div className="crow">
                  <button className="ib" aria-label="Add screenshots or files" title="Add screenshots or files" onClick={() => fileInput.current?.click()}>
                    <Paperclip size={16} />
                  </button>
                  <button className="ib" aria-label="Record a voice note" title="Record a voice note" onClick={rec.start}>
                    <Mic size={16} />
                  </button>
                  {label && <span className="clchip">{label}</span>}
                  <span className="grow" />
                  {c.thinking ? (
                    <button className="cstop" onClick={stop} disabled={c.stopping || act.isPending}>
                      <Square size={11} fill="currentColor" /> {c.stopping ? 'Stopping…' : 'Stop'}
                    </button>
                  ) : (
                    <button className={`csend ${went ? 'go' : ''}`} onClick={() => send()} disabled={act.isPending || (!text.trim() && !files.length)} aria-label="Send">
                      <ArrowUp size={17} />
                    </button>
                  )}
                </div>
              )}
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void add(e.target.files)} />
            </div>
          )
        }
      />
      {size === 'pop' ? (
        <div className="where">
          <span className="chip">
            <Eye size={12} aria-hidden="true" />
            {t.id}
          </span>
          <span>Enter to send</span>
        </div>
      ) : (
        size !== 'phone' && <div className="chint">Enter sends · Shift+Enter for a new line · It answers in the language you write</div>
      )}
    </div>
  );
}

/** A voice note from the microphone. It is sent when you press Done; the agent reads its written text. */
function Recorder({ who, size, onDone, render }: { who: string; size: ChatSize; onDone(f: PickedFile): void; render(r: { on: boolean; start(): void; box: ReactNode }): ReactNode }) {
  const { toast } = usePrefs();
  const [on, setOn] = useState(false);
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const keep = useRef(false);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
  useEffect(() => () => rec.current?.stream.getTracks().forEach((x) => x.stop()), []);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm', 'audio/ogg', 'audio/mp4'].find((x) => MediaRecorder.isTypeSupported?.(x)) ?? '';
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((x) => x.stop());
        if (!keep.current || !chunks.length) return;
        const mime = r.mimeType || type || 'audio/webm';
        const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'weba';
        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        const file = new File(chunks, `voice-note-${stamp}.${ext}`, { type: mime });
        void readFile(file).then(onDone);
      };
      rec.current = r;
      keep.current = false;
      setSecs(0);
      r.start();
      setOn(true);
    } catch {
      toast('The microphone is not available. Allow it for this page, or attach a voice note file.', 'err');
    }
  };
  const finish = (send: boolean) => {
    keep.current = send;
    rec.current?.stop();
    setOn(false);
  };
  const box = (
    <div className={`crec ${size === 'phone' ? 'm' : ''}`} role="group" aria-label="Recording a voice note">
      <span className="crdot" />
      <span className="crt">
        0:{String(secs).padStart(2, '0')} · Recording for the {who}
      </span>
      <span className="clw" aria-hidden="true">
        {Array.from({ length: 22 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${(i % 7) * 0.11}s` }} />
        ))}
      </span>
      <button className="btn sm" onClick={() => finish(false)}>
        Cancel
      </button>
      <button className="btn sm pri" onClick={() => finish(true)}>
        Send
      </button>
    </div>
  );
  return <>{render({ on, start: () => void start(), box })}</>;
}
