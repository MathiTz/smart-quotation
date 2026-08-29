import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { Button, Card, ErrorNote, cx, Spinner } from "../components/ui.js";
import { errorText } from "../lib/errors.js";

const EXAMPLES = [
  "Prioritise lead time over cost. Hard 30 day deadline.",
  "Cheapest wins, but nothing below a 4.2 quality rating.",
  "Keep it to one supplier. Budget $6.5M. Avoid 100% upfront terms.",
];

/** Mirrors MAX_UPLOAD_BYTES on the server, so the message arrives before the wait. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * The server checks all of this too, and its answer is the one that counts. This
 * exists so the user hears about an obviously wrong file immediately rather than
 * after a round trip and a spinner.
 *
 * The `accept` attribute is not a substitute: it only filters the file picker,
 * and a drag-and-drop bypasses it entirely.
 */
function rejectFile(file: File): string | null {
  if (file.size === 0) {
    return "That file is empty. It may still be syncing from cloud storage — try again in a moment.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `That file is ${mb} MB and the limit is 10 MB.`;
  }
  if (!/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
    return `This reads Excel workbooks, and "${file.name}" is not one. Export it as .xlsx and try again.`;
  }
  return null;
}

export function UploadRoute() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** One path for both the picker and the drop zone, so neither skips the checks. */
  function choose(picked: File | null) {
    setError(null);
    if (!picked) {
      setFile(null);
      return;
    }
    const problem = rejectFile(picked);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(picked);
  }

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const quotation = await api.uploadQuotation(file, note);
      navigate(`/quotations/${quotation.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="animate-in">
        <h1 className="text-2xl font-semibold tracking-tight">Upload a supplier quotation</h1>
        <p className="mt-1.5 text-sm text-ink-dim">
          We read the spreadsheet, match every line to your catalog, then use it as the opening
          position against the other suppliers.
        </p>
      </div>

      <Card>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (busy) return;
            choose(e.dataTransfer.files[0] ?? null);
          }}
          onClick={() => !busy && inputRef.current?.click()}
          className={cx(
            "rounded-xl border-2 border-dashed px-6 py-12 text-center transition",
            busy ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            dragging ? "border-accent bg-accent/5" : "border-edge hover:border-ink-faint",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.xls"
            className="hidden"
            disabled={busy}
            // Reset so re-picking the same file after an error still fires change.
            onClick={(e) => {
              (e.target as HTMLInputElement).value = "";
            }}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <>
              <div className="text-sm font-medium text-ink">{file.name}</div>
              <div className="nums mt-1 text-xs text-ink-faint">
                {(file.size / 1024).toFixed(0)} KB — click to choose a different file
              </div>
            </>
          ) : (
            <>
              <div className="text-sm text-ink">Drop an XLSX here, or click to browse</div>
              <div className="mt-1 text-xs text-ink-faint">
                Merged cells, odd headers and mixed formatting are expected
              </div>
            </>
          )}
        </div>

        <div className="mt-5">
          <label htmlFor="note" className="text-sm font-medium">
            What matters on this order?
          </label>
          <p className="mt-1 text-xs text-ink-faint">
            Plain English. This steers how the brand agent weighs cost against lead time, quality and
            payment terms, and it can set hard limits the agent will not cross.
          </p>
          <textarea
            id="note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. prioritize lead time over cost, 30 day deadline"
            className="mt-2 w-full resize-none rounded-lg border border-edge bg-surface-2/60 px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setNote(example)}
                className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint transition hover:border-accent hover:text-accent"
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote message={error} />
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-3">
          {busy && <Spinner label="Parsing and matching…" />}
          <Button variant="primary" disabled={!file || busy} onClick={submit}>
            Parse quotation
          </Button>
        </div>
      </Card>
    </div>
  );
}
