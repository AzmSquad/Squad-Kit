import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Download, Pause, Play, X } from 'lucide-react';
import { ticketFileUrl } from '../api/client';
import { usePrefs } from '../lib/prefs';
import { detect, textClass } from '../lib/lang';
import { Lightbox } from './Lightbox';
import { ChatMarkdown } from './ChatMarkdown';
import { MockupViewer } from './MockupViewer';

export const PICTURE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
export const AUDIO = /\.(ogg|opus|oga|m4a|mp3|wav|aac|amr|flac|weba)$/i;
const MD = /\.(md|markdown)$/i;
const PDF = /\.pdf$/i;
const HTML = /\.html?$/i;

/** A document opened beside the chat. */
export interface OpenDoc {
  ticket: string;
  file: string;
  kind: 'md' | 'pdf';
  /** Who shared it, for the header: "From the Analyst · 10:42". */
  from?: string;
}

export function baseName(f: string): string {
  return f.split(/[\\/]/).pop() ?? f;
}

/** The kind of a file in two or three letters, for its badge. */
export function badgeOf(f: string): { cls: string; label: string } {
  if (MD.test(f)) return { cls: 'md', label: 'MD' };
  if (PDF.test(f)) return { cls: 'pdf', label: 'PDF' };
  if (HTML.test(f)) return { cls: 'html', label: 'HTML' };
  if (PICTURE.test(f)) return { cls: 'img', label: (f.split('.').pop() ?? 'IMG').toUpperCase().slice(0, 4) };
  return { cls: 'file', label: (f.split('.').pop() ?? 'FILE').toUpperCase().slice(0, 4) };
}

/**
 * Files in a message: pictures open big with arrows between them, video plays in place, voice notes play with their
 * written text, Markdown and PDF open beside the chat, and a mockup runs sealed off. Anything else downloads.
 */
export function ChatFiles({ ticket, files, from, onOpen, sent }: { ticket: string; files: string[]; from?: string; onOpen?(d: OpenDoc): void; sent?: boolean }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const [mock, setMock] = useState<{ file: string; from: HTMLElement } | null>(null);
  const pictures = files.filter((f) => PICTURE.test(f));
  const videos = files.filter((f) => VIDEO.test(f));
  const voices = files.filter((f) => AUDIO.test(f));
  const docs = files.filter((f) => !PICTURE.test(f) && !VIDEO.test(f) && !AUDIO.test(f) && !/\.transcript\.txt$/.test(f));
  return (
    <div className="cfiles">
      {pictures.length > 0 && (
        <div className="cshots">
          {pictures.map((f, i) => (
            <button key={f} className="cshot" onClick={() => setZoom(i)} aria-label={`Open ${baseName(f)} big`}>
              <img src={ticketFileUrl(ticket, f)} alt={baseName(f)} loading="lazy" />
              {sent && (
                <span className="cshot-ok" title="Sent">
                  <Check size={11} strokeWidth={3} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {videos.map((f) => (
        <div key={f} className="cvideo">
          <video src={ticketFileUrl(ticket, f)} controls preload="metadata" />
          <Transcript ticket={ticket} file={f} />
        </div>
      ))}
      {voices.map((f) => (
        <VoiceNote key={f} ticket={ticket} file={f} />
      ))}
      {docs.map((f) => {
        const b = badgeOf(f);
        const md = MD.test(f);
        const pdf = PDF.test(f);
        const html = HTML.test(f);
        const meta = md ? 'Markdown · opens beside the chat' : pdf ? 'PDF · opens beside the chat' : html ? 'Mockup · runs here, sealed off' : 'File · downloads';
        const inner = (
          <>
            <span className={`cfic ${b.cls}`}>{b.label}</span>
            <span className="cfile-t">
              <span className="cfname">{baseName(f)}</span>
              <span className="cfmeta">{meta}</span>
            </span>
            <span className="cfopen">{md || pdf || html ? 'Open' : <Download size={14} />}</span>
          </>
        );
        if (md || pdf) {
          return (
            <button key={f} className="cfile" onClick={() => onOpen?.({ ticket, file: f, kind: md ? 'md' : 'pdf', ...(from ? { from } : {}) })}>
              {inner}
            </button>
          );
        }
        if (html) {
          return (
            <button key={f} className="cfile" onClick={(e) => setMock({ file: f, from: e.currentTarget })}>
              {inner}
            </button>
          );
        }
        return (
          <a key={f} className="cfile" href={ticketFileUrl(ticket, f)} download>
            {inner}
          </a>
        );
      })}
      {zoom !== null && <Lightbox pictures={pictures.map((f) => ({ src: ticketFileUrl(ticket, f), caption: baseName(f) }))} start={zoom} onClose={() => setZoom(null)} />}
      {mock && <MockupViewer ticket={ticket} file={mock.file} title={baseName(mock.file)} opener={mock.from} onClose={() => setMock(null)} />}
    </div>
  );
}

/** The written text of a voice or video note, made by speech to text when the agent read it. */
function useTranscript(ticket: string, file: string) {
  return useQuery({
    queryKey: ['transcript', ticket, file],
    queryFn: async () => {
      const res = await fetch(ticketFileUrl(ticket, `${file}.transcript.txt`));
      if (!res.ok) return null;
      // The file starts with a line that says where the text came from.
      return (await res.text()).replace(/^Transcript of [^\n]*\n+/, '').trim() || null;
    },
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data ? false : 10_000),
  });
}

function Transcript({ ticket, file, open: start = true }: { ticket: string; file: string; open?: boolean }) {
  const text = useTranscript(ticket, file).data;
  const [open, setOpen] = useState(start);
  if (!text) return null;
  return (
    <>
      <button className="ctlink" onClick={() => setOpen(!open)}>
        {open ? 'Hide the written text' : 'Show the written text'}
      </button>
      {open && (
        <div className="ctrans">
          {text.split(/\n+/).map((p, i) => {
            const d = detect(p);
            return (
              <p key={i} dir={d.dir} lang={d.dir === 'rtl' ? 'ar' : 'en'} className={textClass(d)}>
                {p}
              </p>
            );
          })}
        </div>
      )}
    </>
  );
}

/** A voice note: play, its length, and what was said written out below. */
export function VoiceNote({ ticket, file }: { ticket: string; file: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ at: 0, length: 0 });
  // A steady wave per file, so the same note always looks the same.
  const bars = useMemo(() => {
    let h = 7;
    for (const ch of file) h = (h * 31 + ch.charCodeAt(0)) % 9973;
    return Array.from({ length: 34 }, (_, i) => 6 + ((h * (i + 3) * 7) % 19));
  }, [file]);
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const tick = () => setTime({ at: a.currentTime, length: Number.isFinite(a.duration) ? a.duration : 0 });
    const end = () => setPlaying(false);
    a.addEventListener('timeupdate', tick);
    a.addEventListener('loadedmetadata', tick);
    a.addEventListener('ended', end);
    return () => {
      a.removeEventListener('timeupdate', tick);
      a.removeEventListener('loadedmetadata', tick);
      a.removeEventListener('ended', end);
    };
  }, []);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play().catch(() => setPlaying(false));
    setPlaying(!playing);
  };
  const shown = playing || time.at > 0 ? time.at : time.length;
  const done = time.length ? Math.min(1, time.at / time.length) : 0;
  return (
    <div className="cvoice-w">
      <div className="cvoice">
        <button className="cplay" onClick={toggle} aria-label={playing ? 'Pause the voice note' : 'Play the voice note'}>
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </button>
        <div className="cwave" aria-hidden="true">
          {bars.map((h, i) => (
            <i key={i} style={{ height: h }} className={i / bars.length < done ? 'on' : ''} />
          ))}
        </div>
        <span className="cvt">{clockOf(shown)}</span>
        <audio ref={audio} src={ticketFileUrl(ticket, file)} preload="metadata" />
      </div>
      <Transcript ticket={ticket} file={file} />
    </div>
  );
}

function clockOf(s: number): string {
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

/** A Markdown or PDF file opened beside the chat, as a readable page. */
export function DocPane({ doc, onClose }: { doc: OpenDoc; onClose(): void }) {
  const { toast } = usePrefs();
  const url = ticketFileUrl(doc.ticket, doc.file);
  const text = useQuery({
    queryKey: ['doc', doc.ticket, doc.file],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('The file could not be read.');
      return res.text();
    },
    enabled: doc.kind === 'md',
  });
  const b = badgeOf(doc.file);
  const copy = () => void navigator.clipboard?.writeText(text.data ?? '').then(() => toast('Document copied'));
  return (
    <section className="cdoc" aria-label={baseName(doc.file)}>
      <div className="cdoc-h">
        <span className={`cfic sm ${b.cls}`}>{b.label}</span>
        <div className="grow">
          <div className="cfname">{baseName(doc.file)}</div>
          <div className="cfmeta">{doc.from ?? (doc.kind === 'md' ? 'Markdown' : 'PDF')}</div>
        </div>
        {doc.kind === 'md' && (
          <button className="btn sm" onClick={copy} disabled={!text.data}>
            Copy
          </button>
        )}
        {doc.kind === 'pdf' && (
          <a className="btn sm" href={url} target="_blank" rel="noreferrer">
            Open in a tab
          </a>
        )}
        <button className="iconbtn" onClick={onClose} aria-label="Close the document">
          <X size={16} />
        </button>
      </div>
      {doc.kind === 'md' ? (
        <div className="cdoc-b">{text.isError ? <p className="note">The file could not be read.</p> : text.data ? <ChatMarkdown text={text.data} ticket={doc.ticket} /> : <p className="note">Loading…</p>}</div>
      ) : (
        <iframe className="cdoc-pdf" src={url} title={baseName(doc.file)} />
      )}
    </section>
  );
}
