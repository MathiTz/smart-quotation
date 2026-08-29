import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";
import { Button, Card, cx, Spinner } from "../components/ui.js";

const EXAMPLES = [
  "Prioritise lead time over cost. Hard 30 day deadline.",
  "Cheapest wins, but nothing below a 4.2 quality rating.",
  "Keep it to one supplier. Budget $6.5M. Avoid 100% upfront terms.",
];

export function UploadRoute() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const quotation = await api.uploadQuotation(file, note);
      navigate(`/quotations/${quotation.id}`);
    } catch (e) {
      setError(
        e instanceof ApiError ? [e.message, e.detail].filter(Boolean).join(" — ") : String(e),
      );
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
            const dropped = e.dataTransfer.files[0];
            if (dropped) setFile(dropped);
          }}
          onClick={() => inputRef.current?.click()}
          className={cx(
            "cursor-pointer rounded-xl border-2 border-dashed px-6 py-12 text-center transition",
            dragging ? "border-accent bg-accent/5" : "border-edge hover:border-ink-faint",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
          <div className="mt-4 rounded-lg border border-bad/40 bg-bad/10 px-3.5 py-2.5 text-sm text-bad">
            {error}
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
