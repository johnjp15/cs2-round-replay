/**
 * The demo coach page (skeleton). A drop zone and the app name; parsing arrives with K1 (the browser parser) and the
 * report with K3/K5. Nothing is uploaded: the file stays in the browser.
 */
import { render } from 'preact';
import { useRef, useState } from 'preact/hooks';
import './theme.css';

const ACCEPT = '.dem,.bz2,.zst,.gz';

function DropZone(props: { onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (files: FileList | null | undefined): void => {
    const f = files?.[0];
    if (f) props.onFile(f);
  };
  return (
    <div
      class={over ? 'drop over' : 'drop'}
      role="button"
      tabIndex={0}
      aria-label="Drop a CS2 demo here or choose a file"
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer?.files); }}
    >
      <strong>Drop a demo here</strong>
      <span>.dem, .dem.bz2 (Valve), .dem.zst (FACEIT) or .dem.gz · or click to choose</span>
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => pick((e.currentTarget as HTMLInputElement).files)} />
    </div>
  );
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  return (
    <main class="page">
      <h1 class="title">CS2 <span class="ct">Demo</span> <span class="t">Coach</span></h1>
      <p class="lede">Three things to fix from one match, each with moments you can watch.</p>
      <DropZone onFile={setFile} />
      {file && <div class="file">{file.name} · {(file.size / 1048576).toFixed(1)} MB · analysis is not built yet</div>}
      <p class="note">Everything runs in this browser tab; the demo is never uploaded.</p>
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
